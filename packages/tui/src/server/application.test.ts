import { Effect, Stream } from "effect";
import {
  MigrationDefinitionId,
  type MigrationDefinitionLock,
  MigrationRunId,
} from "migrate-sdk";
import {
  MigratePlanChangedError,
  type MigratePreparedOperation,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import { describe, expect, it } from "vitest";
import type {
  MigrationTuiExecutablePreparedOperation,
  MigrationTuiExecuteOptions,
  MigrationTuiServerRuntime,
} from "../runtime.ts";
import { makeMigrationServerService } from "./application.ts";

const articlesId = MigrationDefinitionId.make("articles");
const runId = MigrationRunId.make("run-1");

const serverInfo: MigrateServerInfo = {
  capabilities: [
    "cancel-execution",
    "dashboard",
    "observe-execution",
    "prepare-operation",
    "start-operation",
  ],
  configPath: "/workspace/migrate.config.ts",
  environment: { id: "local:/workspace", label: "Local" },
  protocolVersion: 1,
  runtime: { name: "node", version: "24.16.0" },
  sdkVersion: "0.1.0",
};

const makeInternalOperation = (
  executionDefinitionIds: readonly string[] = ["articles"]
): MigrationTuiExecutablePreparedOperation =>
  ({
    action: "run",
    dependencyChecks: [],
    observationDefinitionId: articlesId,
    plan: {
      executionDefinitionIds,
      requestedDefinitionIds: [articlesId],
      withDependencies: false,
    },
    planRows: [],
    target: { definitionId: articlesId, kind: "migration" },
  }) as unknown as MigrationTuiExecutablePreparedOperation;

const makeRuntime = (input?: {
  readonly prepare?: MigrationTuiServerRuntime["prepare"];
  readonly execute?: MigrationTuiServerRuntime["execute"];
}): MigrationTuiServerRuntime => ({
  breakLock: async (lock: MigrationDefinitionLock) => ({
    definitionId: lock.definitionId,
    kind: "cleared",
  }),
  cancelActiveExecution: async () => ({ kind: "idle" }),
  configPath: "/workspace/migrate.config.ts",
  execute:
    input?.execute ??
    (async () => ({
      message: `Run ${runId} succeeded`,
      outcome: "completed",
      runId,
    })),
  getExecutionState: () => undefined,
  groups: [],
  listMessages: async () => [],
  listSourceIdentityHistory: async () => [],
  normalizeSourceIdentity: async (_definitionId, sourceIdentity) =>
    sourceIdentity,
  prepare: input?.prepare ?? (async () => makeInternalOperation()),
  refresh: async () => ({ rows: [], scannedSource: false }),
  rows: [],
  scanSource: async () => ({ rows: [], scannedSource: true }),
  subscribeExecution: () => () => false,
});

describe("Migrate Server application", () => {
  it("starts independently and streams execution progress to completion", async () => {
    const terminal = Promise.withResolvers<void>();
    let executionOptions: MigrationTuiExecuteOptions | undefined;
    const runtime = makeRuntime({
      execute: async (_operation, options) => {
        executionOptions = options;
        options?.onStateChange?.({
          adapter: "inline",
          definitionId: articlesId,
          kind: "running",
          runId,
        });
        await terminal.promise;
        return {
          message: `Run ${runId} succeeded`,
          outcome: "completed",
          runId,
        };
      },
    });
    const server = makeMigrationServerService({ runtime, serverInfo });
    const operation = await Effect.runPromise(
      server.prepareOperation({
        action: "run",
        options: {},
        target: { definitionId: articlesId, kind: "migration" },
      })
    );
    const reference = await Effect.runPromise(
      server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request: {
          action: "run",
          options: {},
          target: { definitionId: articlesId, kind: "migration" },
        },
      })
    );

    expect(reference).toMatchObject({
      adapter: "inline",
      lifecycle: "attached",
      runId,
    });

    const observation = Effect.runPromise(
      server
        .observeExecution({ executionId: reference.executionId })
        .pipe(Stream.runCollect)
    );
    executionOptions?.onProgress?.({ definitions: [] });
    terminal.resolve();

    await expect(observation).resolves.toEqual([
      {
        kind: "state",
        state: {
          adapter: "inline",
          definitionId: articlesId,
          kind: "running",
          runId,
        },
      },
      { definitions: [], kind: "progress" },
      {
        kind: "terminal",
        message: `Run ${runId} succeeded`,
        outcome: "completed",
        runId,
      },
    ]);
  });

  it("closes a detached observation without reporting the run as terminal", async () => {
    const runtime = makeRuntime({
      execute: (_operation, options) => {
        options?.onStateChange?.({
          adapter: "workflow",
          definitionId: articlesId,
          executionId: "workflow-1",
          kind: "observing",
          runId,
        });

        return Promise.resolve({
          message: `Run ${runId} continues in the background`,
          outcome: "detached" as const,
          runId,
        });
      },
    });
    const server = makeMigrationServerService({ runtime, serverInfo });
    const operation = await Effect.runPromise(
      server.prepareOperation({
        action: "run",
        options: {},
        target: { definitionId: articlesId, kind: "migration" },
      })
    );
    const reference = await Effect.runPromise(
      server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request: {
          action: "run",
          options: {},
          target: { definitionId: articlesId, kind: "migration" },
        },
      })
    );
    const events = await Effect.runPromise(
      server
        .observeExecution({ executionId: reference.executionId })
        .pipe(Stream.runCollect)
    );

    expect(reference.lifecycle).toBe("detached");
    expect(events).toEqual([
      {
        kind: "state",
        state: {
          adapter: "workflow",
          definitionId: articlesId,
          executionId: "workflow-1",
          kind: "observing",
          runId,
        },
      },
      {
        kind: "detached",
        message: `Run ${runId} continues in the background`,
        runId,
      },
    ]);
  });

  it("rejects a confirmed operation when replanning changes its fingerprint", async () => {
    let prepareCalls = 0;
    const runtime = makeRuntime({
      prepare: () => {
        prepareCalls += 1;
        return Promise.resolve(
          makeInternalOperation(
            prepareCalls === 1 ? ["articles"] : ["authors", "articles"]
          )
        );
      },
    });
    const server = makeMigrationServerService({ runtime, serverInfo });
    const operation: MigratePreparedOperation = await Effect.runPromise(
      server.prepareOperation({
        action: "run",
        options: {},
        target: { definitionId: articlesId, kind: "migration" },
      })
    );

    await expect(
      Effect.runPromise(
        server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request: {
            action: "run",
            options: {},
            target: { definitionId: articlesId, kind: "migration" },
          },
        })
      )
    ).rejects.toBeInstanceOf(MigratePlanChangedError);
  });
});
