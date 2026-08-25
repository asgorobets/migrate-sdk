import { fileURLToPath } from "node:url";
import {
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import { liveProgressProviderObservations } from "../examples/live-progress-fixture.ts";
import { loadConfiguredMigrationHost } from "./runtime.ts";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const authorsId = toMigrationDefinitionId("authors");
const articlesId = toMigrationDefinitionId("articles");
const assetsId = toMigrationDefinitionId("assets");
const contentGroupId = toMigrationDefinitionGroupId("content");
const succeededRunPattern = /^Run .+ succeeded$/;

describe("Migration TUI server runtime", () => {
  const liveProgressCases = [
    {
      configPath: "examples/live-progress.config.ts",
      executionState: "running",
      label: "attached inline",
      observationWarning: false,
    },
    {
      configPath: "examples/detached-live-progress.config.ts",
      executionState: "observing",
      label: "detached durable",
      observationWarning: false,
    },
    {
      configPath: "examples/provider-observation-failure.config.ts",
      executionState: "observing",
      label: "provider observation fallback",
      observationWarning: true,
    },
  ] as const;

  it("loads the CLI config through the shared loader", async () => {
    const runtime = await loadConfiguredMigrationHost({
      cwd: fileURLToPath(new URL("../examples", import.meta.url)),
    });

    expect(runtime.configPath).toBe(
      fileURLToPath(new URL("../examples/migrate.config.ts", import.meta.url))
    );
    expect(runtime.rows.map((row) => row.entry.id)).toEqual([
      "authors",
      "articles",
      "assets",
    ]);
    expect(runtime.groups).toEqual([
      {
        definitionIds: ["authors", "articles", "assets"],
        id: contentGroupId,
      },
    ]);
  });

  it("prepares an executable SDK plan before executing it", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { definitionId: articlesId, kind: "migration" },
      "retry-failed"
    );

    expect(operation).toMatchObject({
      action: "retry-failed",
      observationDefinitionId: articlesId,
      plan: {
        executionDefinitionIds: ["articles"],
        includedDefinitionIds: ["articles"],
        kind: "run",
        mode: { kind: "failed" },
        withDependencies: false,
      },
    });

    await expect(runtime.execute(operation)).resolves.toEqual({
      message: expect.stringMatching(succeededRunPattern),
      outcome: "completed",
      runId: expect.any(String),
    });
    const snapshot = await runtime.refresh();
    const articles = snapshot.rows.find((row) => row.entry.id === articlesId);

    expect(articles?.status?.durable.failed).toBe(0);
    expect(articles?.status?.durable.migrated).toBe(2);
  });

  for (const testCase of liveProgressCases) {
    it(`publishes live durable counts during ${testCase.label} execution`, async () => {
      liveProgressProviderObservations.length = 0;
      const runtime = await loadConfiguredMigrationHost({
        configPath: testCase.configPath,
        cwd: packageDirectory,
        progressFallbackIntervalMs: 10,
        terminalPollIntervalMs: 10,
      });
      const operation = await runtime.prepare(
        {
          definitionId: toMigrationDefinitionId("live-progress"),
          kind: "migration",
        },
        "run"
      );
      const executionStates: string[] = [];
      const migratedCounts: number[] = [];
      const observationWarnings: string[] = [];
      let sawIntermediateProgressWhileRunning = false;
      const execution = runtime.execute(operation, {
        onProgress: ({ definitions }) => {
          const status = definitions.find(
            (definition) => definition.definitionId === "live-progress"
          );

          if (status !== undefined) {
            migratedCounts.push(status.durable.migrated);
            if (status.durable.migrated > 0 && status.durable.migrated < 4) {
              sawIntermediateProgressWhileRunning = true;
            }
          }
        },
        onObservationWarning: (warning) => observationWarnings.push(warning),
        onStateChange: (state) => executionStates.push(state.kind),
      });

      await expect(execution).resolves.toEqual({
        message: expect.stringMatching(succeededRunPattern),
        outcome: "completed",
        runId: expect.any(String),
      });

      expect(executionStates).toContain(testCase.executionState);
      expect(sawIntermediateProgressWhileRunning).toBe(true);
      expect(migratedCounts.at(-1)).toBe(4);
      expect(liveProgressProviderObservations).toHaveLength(
        testCase.executionState === "observing" ? 1 : 0
      );
      expect(observationWarnings.length > 0).toBe(testCase.observationWarning);
    });
  }

  it("publishes live durable counts when a dependent migration runs alone", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/dependent-live-progress.config.ts",
      cwd: packageDirectory,
      progressFallbackIntervalMs: 10,
      terminalPollIntervalMs: 10,
    });
    const prerequisite = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("live-progress-prerequisite"),
        kind: "migration",
      },
      "run"
    );
    await runtime.execute(prerequisite);
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("live-progress"),
        kind: "migration",
      },
      "run"
    );
    const migratedCounts: number[] = [];
    const progressErrors: unknown[] = [];

    expect(operation.plan.executionDefinitionIds).toEqual(["live-progress"]);

    await runtime.execute(operation, {
      onProgress: ({ definitions }) => {
        const status = definitions.find(
          (definition) => definition.definitionId === "live-progress"
        );

        if (status !== undefined) {
          migratedCounts.push(status.durable.migrated);
        }
      },
      onProgressError: (cause) => progressErrors.push(cause),
    });

    expect(migratedCounts.some((count) => count > 0 && count < 4)).toBe(true);
    expect(migratedCounts.at(-1)).toBe(4);
    expect(progressErrors).toEqual([]);
  });

  it("rediscovers and observes a detached run by its durable run id", async () => {
    liveProgressProviderObservations.length = 0;
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/detached-live-progress.config.ts",
      cwd: packageDirectory,
      progressFallbackIntervalMs: 10,
      terminalPollIntervalMs: 10,
    });
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("live-progress"),
        kind: "migration",
      },
      "run"
    );
    const observing = Promise.withResolvers<void>();
    const firstObservation = runtime.execute(operation, {
      onStateChange: (state) => {
        if (state.kind === "observing") {
          observing.resolve();
        }
      },
    });

    await observing.promise;
    await expect(runtime.cancelActiveExecution()).resolves.toMatchObject({
      kind: "detached",
    });
    const detached = await firstObservation;
    const activeRuns = await runtime.listActiveRuns();

    expect(detached).toMatchObject({ outcome: "detached" });
    expect(activeRuns).toEqual([
      expect.objectContaining({
        definitionIds: ["live-progress"],
        execution: {
          adapter: "test-detached",
          executionId: `detached-${detached.runId}`,
        },
        runId: detached.runId,
        status: "running",
      }),
    ]);
    await expect(runtime.observeRun(detached.runId)).resolves.toEqual({
      message: `Run ${detached.runId} succeeded`,
      outcome: "completed",
      runId: detached.runId,
    });
    await expect(runtime.observeRun(detached.runId)).resolves.toEqual({
      message: `Run ${detached.runId} succeeded`,
      outcome: "completed",
      runId: detached.runId,
    });
    expect(liveProgressProviderObservations).toEqual([
      `detached-${detached.runId}`,
      `detached-${detached.runId}`,
    ]);
  });

  it("prepares skipped-item retries without expanding dependencies", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { definitionId: assetsId, kind: "migration" },
      "retry-skipped"
    );

    expect(operation).toMatchObject({
      action: "retry-skipped",
      observationDefinitionId: assetsId,
      plan: {
        executionDefinitionIds: ["assets"],
        includedDefinitionIds: ["assets"],
        kind: "run",
        mode: { kind: "skipped" },
        withDependencies: false,
      },
    });
  });

  it("returns source inventory and warnings after a Source Inventory Scan", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/source-status.config.ts",
      cwd: packageDirectory,
    });
    const durableOnly = await runtime.refresh();
    const scanned = await runtime.scanSource({
      definitionId: toMigrationDefinitionId("products"),
      kind: "migration",
    });

    expect(durableOnly.rows[0]?.status?.source).toBeUndefined();
    expect(scanned.rows[0]?.status).toMatchObject({
      source: {
        duplicate: 1,
        invalid: 0,
        orphaned: 0,
        total: 3,
        unprocessed: 2,
      },
      warnings: [
        {
          _tag: "DuplicateSourceIdentityStatusWarning",
          count: 1,
          sourceIdentity: "product-duplicate",
        },
      ],
    });
  });

  it("scans source status only for the selected migration scope", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const scanned = await runtime.scanSource({
      definitionId: authorsId,
      kind: "migration",
    });
    const rowsById = new Map(scanned.rows.map((row) => [row.entry.id, row]));

    expect(rowsById.get(authorsId)?.status?.source).toMatchObject({ total: 2 });
    expect(rowsById.get(articlesId)?.status?.source).toBeUndefined();
    expect(rowsById.get(assetsId)?.status?.source).toBeUndefined();
  });

  it("breaks a persisted migration lock through its configured store", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/locked.config.ts",
      cwd: packageDirectory,
    });
    const definitionId = toMigrationDefinitionId("locked-migration");
    const initial = await runtime.refresh();
    const lock = initial.rows[0]?.status?.lock;

    expect(initial.activeRuns).toEqual([]);
    expect(lock).toMatchObject({
      ownerRunId: "run-stuck",
      token: "lock-stuck",
    });
    expect(lock).not.toBeNull();
    expect(lock).not.toBeUndefined();

    if (lock == null) {
      throw new Error("Expected the fixture migration to be locked");
    }

    await expect(
      runtime.breakLock({
        ...lock,
        token: toMigrationDefinitionLockToken("lock-replaced"),
      })
    ).rejects.toThrow("Migration definition lock is owned by another runner");
    expect((await runtime.refresh()).rows[0]?.status?.lock).toMatchObject({
      ownerRunId: "run-stuck",
      token: "lock-stuck",
    });
    await expect(runtime.breakLock(lock)).resolves.toEqual({
      definitionId,
      kind: "cleared",
    });
    expect((await runtime.refresh()).rows[0]?.status?.lock).toBeNull();
    await expect(runtime.breakLock(lock)).resolves.toEqual({
      definitionId,
      kind: "already-clear",
    });
  });

  it("prepares multiple source identities from durable item history", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const history = await runtime.listSourceIdentityHistory(articlesId);
    const sourceIdentities = history.map((entry) => entry.sourceIdentity);
    const operation = await runtime.prepare(
      { definitionId: articlesId, kind: "migration" },
      "run",
      { sourceIdentities }
    );

    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceIdentity: "article-welcome",
          status: "migrated",
        }),
        expect.objectContaining({
          sourceIdentity: "article-effect",
          status: "failed",
        }),
      ])
    );
    await expect(
      runtime.normalizeSourceIdentity(articlesId, "article%2Dwelcome")
    ).resolves.toBe("article-welcome");
    expect(operation).toMatchObject({
      action: "run",
      plan: {
        target: {
          definitionId: articlesId,
          sourceIdentities: ["article-welcome", "article-effect"],
        },
      },
      sourceIdentities: ["article-welcome", "article-effect"],
    });
  });

  it("preserves the owning migration for messages in a group", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const messages = await runtime.listMessages({
      groupId: contentGroupId,
      kind: "group",
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          definitionId: articlesId,
          message: "Published article route",
          sourceIdentity: "article-welcome",
        }),
        expect.objectContaining({
          definitionId: assetsId,
          message: "Asset already exists at the destination",
          sourceIdentity: "asset-logo",
        }),
      ])
    );
  });

  it("prepares rollback dependencies in reverse execution order", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { definitionId: authorsId, kind: "migration" },
      "rollback"
    );

    expect(operation).toMatchObject({
      action: "rollback",
      observationDefinitionId: authorsId,
      plan: {
        executionDefinitionIds: ["articles", "authors"],
        includedDefinitionIds: ["authors", "articles"],
        kind: "rollback",
        withDependencies: true,
      },
      planRows: [{ entry: { id: "articles" } }, { entry: { id: "authors" } }],
    });
  });

  it("reports unmet run dependencies and prepares include or force resolutions", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/dependency-preflight.config.ts",
      cwd: packageDirectory,
    });
    const target = { definitionId: articlesId, kind: "migration" } as const;
    const selectedOnly = await runtime.prepare(target, "run");
    const expanded = await runtime.prepare(target, "run", {
      withDependencies: true,
    });
    const forced = await runtime.prepare(target, "run", {
      force: true,
      withDependencies: false,
    });

    expect(selectedOnly).toMatchObject({
      dependencyChecks: [
        {
          dependencyId: "authors",
          requiredByDefinitionId: "articles",
          satisfied: false,
        },
      ],
      plan: {
        executionDefinitionIds: ["articles"],
        withDependencies: false,
      },
      planRows: [{ entry: { id: "articles" } }],
    });
    expect(expanded).toMatchObject({
      dependencyChecks: [],
      plan: {
        executionDefinitionIds: ["authors", "articles"],
        withDependencies: true,
      },
    });
    expect(forced).toMatchObject({
      plan: {
        executionDefinitionIds: ["articles"],
        force: true,
        withDependencies: false,
      },
    });
  });

  it("prepares a group plan without expanding external dependencies", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const operation = await runtime.prepare(
      { groupId: contentGroupId, kind: "group" },
      "run"
    );

    expect(operation).toMatchObject({
      action: "run",
      observationDefinitionId: "authors",
      plan: {
        executionDefinitionIds: ["authors", "assets", "articles"],
        includedDefinitionIds: ["authors", "articles", "assets"],
        kind: "run",
        requestedGroup: contentGroupId,
        withDependencies: false,
      },
      target: { groupId: contentGroupId, kind: "group" },
    });
  });

  it("applies session concurrency to run, rollback, and Source Inventory Scan requests", async () => {
    const runtime = await loadConfiguredMigrationHost({
      configPath: "examples/migrate.config.ts",
      cwd: packageDirectory,
    });
    const target = { groupId: contentGroupId, kind: "group" } as const;
    const run = await runtime.prepare(target, "run", {
      execution: {
        process: { concurrency: 3 },
        rollback: { concurrency: "unbounded" },
      },
    });
    const rollback = await runtime.prepare(target, "rollback", {
      execution: { rollback: { concurrency: 2 } },
    });

    expect(run.plan.execution).toEqual({
      process: { concurrency: 3 },
      rollback: { concurrency: "unbounded" },
    });
    expect(rollback.plan.execution).toEqual({
      rollback: { concurrency: 2 },
    });
    await expect(
      runtime.scanSource(target, { concurrency: 0 })
    ).rejects.toThrow("positive integer");
  });
});
