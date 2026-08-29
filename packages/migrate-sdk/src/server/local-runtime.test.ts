/** @effect-diagnostics asyncFunction:skip-file */
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Fiber } from "effect";
import {
  type MigrationRunId,
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import {
  type ExecutableMigrationOperation,
  loadLocalMigrateServerRuntime as loadLocalMigrateServerRuntimeEffect,
  type RegistryMigrateServerExecutionObserver,
  type RegistryMigrateServerRuntime,
} from "migrate-sdk/server";
import { describe, expect, it } from "vitest";

const serverFixtureUrl = new URL(
  "../../test/fixtures/server/",
  import.meta.url
);
const fixtureDirectory = fileURLToPath(serverFixtureUrl);
const loadLiveProgressFixture = () =>
  import(
    new URL("live-progress-fixture.ts", serverFixtureUrl).href
  ) as Promise<{
    readonly liveProgressProviderObservations: string[];
  }>;
const loadScopedExecutableFixture = () =>
  import(
    new URL("scoped-executable-support.ts", serverFixtureUrl).href
  ) as Promise<{
    readonly resetScopedExecutableState: () => void;
    readonly scopedExecutableState: () => {
      readonly acquisitions: number;
      readonly releases: number;
    };
  }>;
const authorsId = toMigrationDefinitionId("authors");
const articlesId = toMigrationDefinitionId("articles");
const assetsId = toMigrationDefinitionId("assets");
const contentGroupId = toMigrationDefinitionGroupId("content");
const succeededRunPattern = /^Run .+ succeeded$/;
const loadLocalMigrateServerRuntime = async (
  ...args: Parameters<typeof loadLocalMigrateServerRuntimeEffect>
) => {
  const runtime = await Effect.runPromise(
    Effect.scoped(loadLocalMigrateServerRuntimeEffect(...args))
  );

  return {
    ...runtime,
    breakLock: (lock: Parameters<typeof runtime.breakLock>[0]) =>
      Effect.runPromise(runtime.breakLock(lock)),
    listActiveRuns: () => Effect.runPromise(runtime.listActiveRuns),
    listMessages: (...input: Parameters<typeof runtime.listMessages>) =>
      Effect.runPromise(runtime.listMessages(...input)),
    listSourceIdentityHistory: (
      ...input: Parameters<typeof runtime.listSourceIdentityHistory>
    ) => Effect.runPromise(runtime.listSourceIdentityHistory(...input)),
    normalizeSourceIdentity: (
      ...input: Parameters<typeof runtime.normalizeSourceIdentity>
    ) => Effect.runPromise(runtime.normalizeSourceIdentity(...input)),
    prepare: (...input: Parameters<typeof runtime.prepare>) =>
      Effect.runPromise(runtime.prepare(...input)),
    refresh: () => Effect.runPromise(runtime.refresh),
    scanSource: (...input: Parameters<typeof runtime.scanSource>) =>
      Effect.runPromise(runtime.scanSource(...input)),
  };
};

const executeRegistryMigration = async (
  runtime: Pick<RegistryMigrateServerRuntime, "startExecution">,
  operation: ExecutableMigrationOperation,
  options?: RegistryMigrateServerExecutionObserver
) => {
  const execution = await Effect.runPromise(
    runtime.startExecution(operation, options)
  );

  return Effect.runPromise(execution.result);
};

describe("Local Migrate Server runtime", () => {
  const liveProgressCases = [
    {
      configPath: "live-progress.config.ts",
      label: "attached inline",
      observationWarning: false,
      ownership: "server",
    },
    {
      configPath: "detached-live-progress.config.ts",
      label: "detached durable",
      observationWarning: false,
      ownership: "provider",
    },
    {
      configPath: "provider-observation-failure.config.ts",
      label: "provider observation fallback",
      observationWarning: true,
      ownership: "provider",
    },
  ] as const;

  it("loads the CLI config through the shared loader", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      cwd: fixtureDirectory,
    });

    expect(runtime.configPath).toBe(
      fileURLToPath(new URL("migrate.config.ts", serverFixtureUrl))
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

  it("keeps the Migration Executable layer alive for the runtime scope", async () => {
    const { resetScopedExecutableState, scopedExecutableState } =
      await loadScopedExecutableFixture();
    resetScopedExecutableState();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* loadLocalMigrateServerRuntimeEffect({
            configPath: "scoped-executable.config.ts",
            cwd: fixtureDirectory,
          });

          expect(scopedExecutableState()).toEqual({
            acquisitions: 1,
            releases: 0,
          });

          const operation = yield* runtime.prepare(
            {
              definitionId: toMigrationDefinitionId(
                "scoped-executable-fixture"
              ),
              kind: "migration",
            },
            "run"
          );
          const execution = yield* runtime.startExecution(operation);
          const result = yield* execution.result;

          expect(result.outcome).toBe("completed");
        })
      )
    );

    expect(scopedExecutableState()).toEqual({
      acquisitions: 1,
      releases: 1,
    });
  });

  it("prepares an executable SDK plan before executing it", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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

    await expect(executeRegistryMigration(runtime, operation)).resolves.toEqual(
      {
        message: expect.stringMatching(succeededRunPattern),
        outcome: "completed",
        runId: expect.any(String),
      }
    );
    const snapshot = await runtime.refresh();
    const articles = snapshot.rows.find((row) => row.entry.id === articlesId);

    expect(articles?.status?.durable.failed).toBe(0);
    expect(articles?.status?.durable.migrated).toBe(2);
  });

  it("drains attached SDK work when the execution fiber is interrupted", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "cancellation.config.ts",
      cwd: fixtureDirectory,
    });
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("cancellable"),
        kind: "migration",
      },
      "run"
    );
    const running = await Effect.runPromise(Deferred.make<void>());
    const execution = await Effect.runPromise(
      runtime.startExecution(operation, {
        onStateChange: (state) => {
          if (state.kind === "running") {
            Deferred.doneUnsafe(running, Effect.void);
          }
        },
      })
    );

    const fiber = Effect.runFork(execution.result);
    await Effect.runPromise(Deferred.await(running));

    expect(runtime.hasActiveExecutions()).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(runtime.hasActiveExecutions()).toBe(false);
    expect((await runtime.refresh()).rows[0]?.status?.lastRun?.status).toBe(
      "cancelled"
    );
  }, 10_000);

  for (const testCase of liveProgressCases) {
    it(`publishes live durable counts during ${testCase.label} execution`, async () => {
      const { liveProgressProviderObservations } =
        await loadLiveProgressFixture();
      liveProgressProviderObservations.length = 0;
      const runtime = await loadLocalMigrateServerRuntime({
        configPath: testCase.configPath,
        cwd: fixtureDirectory,
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
      const executionOwnerships: string[] = [];
      const migratedCounts: number[] = [];
      const observationWarnings: string[] = [];
      let sawIntermediateProgressWhileRunning = false;
      const execution = executeRegistryMigration(runtime, operation, {
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
        onStateChange: (state) => {
          if (state.kind === "running") {
            executionOwnerships.push(state.ownership);
          }
        },
      });

      await expect(execution).resolves.toEqual({
        message: expect.stringMatching(succeededRunPattern),
        outcome: "completed",
        runId: expect.any(String),
      });

      expect(executionOwnerships).toContain(testCase.ownership);
      expect(sawIntermediateProgressWhileRunning).toBe(true);
      expect(migratedCounts.at(-1)).toBe(4);
      expect(liveProgressProviderObservations).toHaveLength(
        testCase.ownership === "provider" ? 1 : 0
      );
      expect(observationWarnings.length > 0).toBe(testCase.observationWarning);
    });
  }

  it("reads Source Item totals without starting or observing a run", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "live-progress.config.ts",
      cwd: fixtureDirectory,
    });

    await expect(
      Effect.runPromise(
        runtime.getSourceItemTotals([toMigrationDefinitionId("live-progress")])
      )
    ).resolves.toEqual([
      {
        definitionId: "live-progress",
        total: { count: 4, kind: "known" },
      },
    ]);
  });

  it("publishes live durable counts when a dependent migration runs alone", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "dependent-live-progress.config.ts",
      cwd: fixtureDirectory,
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
    await executeRegistryMigration(runtime, prerequisite);
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

    await executeRegistryMigration(runtime, operation, {
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
    const { liveProgressProviderObservations } =
      await loadLiveProgressFixture();
    liveProgressProviderObservations.length = 0;
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "detached-live-progress.config.ts",
      cwd: fixtureDirectory,
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
    const observing = await Effect.runPromise(Deferred.make<void>());
    let detachedRunId: MigrationRunId | undefined;
    const execution = await Effect.runPromise(
      runtime.startExecution(operation, {
        onStateChange: (state) => {
          if (state.kind === "running" && state.ownership === "provider") {
            detachedRunId = state.runId;
            Deferred.doneUnsafe(observing, Effect.void);
          }
        },
      })
    );
    const firstObservation = Effect.runFork(execution.result);

    await Effect.runPromise(Deferred.await(observing));
    await expect(Effect.runPromise(execution.stop)).resolves.toMatchObject({
      kind: "requested",
    });
    await Effect.runPromise(Fiber.interrupt(firstObservation));

    if (detachedRunId === undefined) {
      throw new Error("Expected a detached Migration Run id");
    }

    const activeRuns = await runtime.listActiveRuns();

    expect(activeRuns).toEqual([
      expect.objectContaining({
        definitionIds: ["live-progress"],
        execution: {
          adapter: "test-detached",
          executionId: `detached-${detachedRunId}`,
        },
        runId: detachedRunId,
        status: "cancelling",
      }),
    ]);
    await expect(
      Effect.runPromise(runtime.getRunProgress(detachedRunId))
    ).resolves.toEqual({
      definitions: [expect.objectContaining({ definitionId: "live-progress" })],
      observationDefinitionId: "live-progress",
    });
    await expect(
      Effect.runPromise(runtime.observeRun(detachedRunId))
    ).resolves.toEqual({
      message: `Run ${detachedRunId} cancelled`,
      outcome: "cancelled",
      runId: detachedRunId,
    });
    await expect(
      Effect.runPromise(runtime.observeRun(detachedRunId))
    ).resolves.toEqual({
      message: `Run ${detachedRunId} cancelled`,
      outcome: "cancelled",
      runId: detachedRunId,
    });
    expect(liveProgressProviderObservations).toEqual([
      `detached-${detachedRunId}`,
      `detached-${detachedRunId}`,
    ]);
  });

  it("returns a failed terminal outcome for a durably completed run", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "failed-run.config.ts",
      cwd: fixtureDirectory,
    });
    const runId = toMigrationRunId("failed-run-1");

    await expect(
      Effect.runPromise(runtime.getRunProgress(runId))
    ).resolves.toEqual({
      definitions: [expect.objectContaining({ definitionId: "failed-run" })],
      observationDefinitionId: "failed-run",
    });

    await expect(Effect.runPromise(runtime.observeRun(runId))).resolves.toEqual(
      {
        message: `Run ${runId} failed`,
        outcome: "failed",
        runId,
      }
    );
  });

  it("prepares skipped-item retries without expanding dependencies", async () => {
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "source-status.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "locked.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "dependency-preflight.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
    const runtime = await loadLocalMigrateServerRuntime({
      configPath: "migrate.config.ts",
      cwd: fixtureDirectory,
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
