import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import {
  type MigrateActiveRun,
  MigratePlanChangedError,
  type MigratePreparedOperation,
  type MigrateServerInfo,
} from "../protocol/index.ts";
import {
  MigrateServer,
  type MigrateServerBackend,
  type MigrateServerExecutionObserver,
} from "./service.ts";

const articlesId = MigrationDefinitionId.make("articles");
const runId = MigrationRunId.make("run-1");
const activeRun: MigrateActiveRun = {
  definitionIds: [articlesId],
  execution: {
    adapter: "workflow-sdk",
    executionId: "workflow-run-1",
  },
  observationDefinitionId: articlesId,
  runId,
  startedAt: new Date("2026-08-25T12:00:00.000Z"),
  status: "running",
};

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
  protocolVersion: 2,
  runtime: { name: "node", version: "24.16.0" },
  sdkVersion: "0.1.0",
};

interface FakeExecutableOperation {
  readonly executionDefinitionIds: readonly string[];
}

const preparedOperation = (
  executionDefinitionIds: readonly string[] = ["articles"]
): {
  readonly executable: FakeExecutableOperation;
  readonly operation: Omit<MigratePreparedOperation, "fingerprint">;
} => ({
  executable: { executionDefinitionIds },
  operation: {
    action: "run",
    dependencyChecks: [],
    observationDefinitionId: articlesId,
    plan: {
      executionDefinitionIds: executionDefinitionIds.map((definitionId) =>
        MigrationDefinitionId.make(definitionId)
      ),
      requestedDefinitionIds: [articlesId],
      withDependencies: false,
    },
    planRows: [],
    target: { definitionId: articlesId, kind: "migration" },
  },
});

const makeBackend = (input?: {
  readonly cancelActiveExecution?: MigrateServerBackend<FakeExecutableOperation>["cancelActiveExecution"];
  readonly executeOperation?: MigrateServerBackend<FakeExecutableOperation>["executeOperation"];
  readonly getActiveRuns?: MigrateServerBackend<FakeExecutableOperation>["getActiveRuns"];
  readonly observeRun?: MigrateServerBackend<FakeExecutableOperation>["observeRun"];
  readonly prepareOperation?: MigrateServerBackend<FakeExecutableOperation>["prepareOperation"];
}): MigrateServerBackend<FakeExecutableOperation> => ({
  breakLock: (lock: MigrationDefinitionLock) =>
    Effect.succeed({
      definitionId: lock.definitionId,
      kind: "cleared",
    }),
  cancelActiveExecution:
    input?.cancelActiveExecution ?? Effect.succeed({ kind: "idle" }),
  executeOperation:
    input?.executeOperation ??
    (() =>
      Effect.succeed({
        message: `Run ${runId} succeeded`,
        outcome: "completed",
        runId,
      })),
  getActiveRuns: input?.getActiveRuns ?? Effect.succeed([]),
  getDashboard: Effect.succeed({
    activeRuns: [],
    groups: [],
    rows: [],
    scannedSource: false,
  }),
  getMessages: () => Effect.succeed([]),
  getSourceIdentityHistory: () => Effect.succeed([]),
  normalizeSourceIdentity: (_definitionId, sourceIdentity) =>
    Effect.succeed(sourceIdentity),
  observeRun:
    input?.observeRun ??
    (() =>
      Effect.succeed({
        message: `Run ${runId} succeeded`,
        outcome: "completed",
        runId,
      })),
  prepareOperation:
    input?.prepareOperation ?? (() => Effect.succeed(preparedOperation())),
  scanSource: () =>
    Effect.succeed({
      activeRuns: [],
      groups: [],
      rows: [],
      scannedSource: true,
    }),
});

const makeServer = (backend: MigrateServerBackend<FakeExecutableOperation>) =>
  MigrateServer.make({ backend, serverInfo });

describe("Migrate Server", () => {
  it.effect(
    "discovers and observes an active run without the transient execution map",
    () =>
      Effect.gen(function* () {
        const backend = makeBackend({
          getActiveRuns: Effect.succeed([activeRun]),
          observeRun: (requestedRunId, observer) => {
            expect(requestedRunId).toBe(runId);
            observer.onProgress({ definitions: [] });

            return Effect.succeed({
              message: `Run ${runId} succeeded`,
              outcome: "completed" as const,
              runId,
            });
          },
        });
        const originalServer = yield* makeServer(backend);

        expect(yield* originalServer.getActiveRuns).toEqual([activeRun]);

        const replacementServer = yield* makeServer(backend);
        const events = yield* replacementServer
          .observeRun({ runId })
          .pipe(Stream.runCollect);

        expect(yield* replacementServer.getActiveRuns).toEqual([activeRun]);
        expect(events).toEqual([
          { definitions: [], kind: "progress" },
          {
            kind: "terminal",
            message: `Run ${runId} succeeded`,
            outcome: "completed",
            runId,
          },
        ]);
      })
  );

  it.effect("ends run observation without requesting cancellation", () =>
    Effect.gen(function* () {
      const observationStarted = yield* Deferred.make<void>();
      const observationEnded = yield* Deferred.make<void>();
      let cancellationRequests = 0;
      const server = yield* makeServer(
        makeBackend({
          cancelActiveExecution: Effect.sync(() => {
            cancellationRequests += 1;
            return { kind: "idle" as const };
          }),
          getActiveRuns: Effect.succeed([activeRun]),
          observeRun: () =>
            Effect.acquireUseRelease(
              Deferred.succeed(observationStarted, undefined),
              () => Effect.never,
              () => Deferred.succeed(observationEnded, undefined)
            ),
        })
      );
      const observation = yield* server
        .observeRun({ runId })
        .pipe(Stream.runDrain, Effect.forkChild);

      yield* Deferred.await(observationStarted);
      yield* Fiber.interrupt(observation);
      yield* Deferred.await(observationEnded);

      expect(cancellationRequests).toBe(0);
      expect(yield* server.getActiveRuns).toEqual([activeRun]);
    })
  );

  it.effect(
    "starts independently and streams execution progress to completion",
    () =>
      Effect.gen(function* () {
        const terminal = yield* Deferred.make<void>();
        let observer: MigrateServerExecutionObserver | undefined;
        const server = yield* makeServer(
          makeBackend({
            executeOperation: (_operation, nextObserver) => {
              observer = nextObserver;
              nextObserver.onStateChange({
                adapter: "inline",
                definitionId: articlesId,
                kind: "running",
                runId,
              });
              return Deferred.await(terminal).pipe(
                Effect.as({
                  message: `Run ${runId} succeeded`,
                  outcome: "completed" as const,
                  runId,
                })
              );
            },
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          target: { definitionId: articlesId, kind: "migration" as const },
        };
        const operation = yield* server.prepareOperation(request);
        const reference = yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });

        expect(reference).toMatchObject({
          adapter: "inline",
          lifecycle: "attached",
          runId,
        });

        const observation = yield* server
          .observeExecution({ executionId: reference.executionId })
          .pipe(Stream.runCollect, Effect.forkChild);
        observer?.onProgress({ definitions: [] });
        yield* Deferred.succeed(terminal, undefined);

        expect(yield* Fiber.join(observation)).toEqual([
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
      })
  );

  it.effect(
    "closes a detached observation without reporting the run as terminal",
    () =>
      Effect.gen(function* () {
        const server = yield* makeServer(
          makeBackend({
            executeOperation: (_operation, observer) => {
              observer.onStateChange({
                adapter: "workflow",
                definitionId: articlesId,
                executionId: "workflow-1",
                kind: "observing",
                runId,
              });

              return Effect.succeed({
                message: `Run ${runId} continues in the background`,
                outcome: "detached" as const,
                runId,
              });
            },
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          target: { definitionId: articlesId, kind: "migration" as const },
        };
        const operation = yield* server.prepareOperation(request);
        const reference = yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });
        const events = yield* server
          .observeExecution({ executionId: reference.executionId })
          .pipe(Stream.runCollect);

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
      })
  );

  it.effect(
    "rejects a confirmed operation when replanning changes its fingerprint",
    () =>
      Effect.gen(function* () {
        let prepareCalls = 0;
        const server = yield* makeServer(
          makeBackend({
            prepareOperation: () => {
              prepareCalls += 1;
              return Effect.succeed(
                preparedOperation(
                  prepareCalls === 1 ? ["articles"] : ["authors", "articles"]
                )
              );
            },
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          target: { definitionId: articlesId, kind: "migration" as const },
        };
        const operation = yield* server.prepareOperation(request);

        const error = yield* Effect.flip(
          server.startOperation({
            acceptedFingerprint: operation.fingerprint,
            request,
          })
        );
        expect(error).toBeInstanceOf(MigratePlanChangedError);
      })
  );

  it.effect(
    "rejects a concurrent start without losing cancellation of the active execution",
    () =>
      Effect.gen(function* () {
        const terminal = yield* Deferred.make<void>();
        let cancellationRequests = 0;
        let executionAttempts = 0;
        const server = yield* makeServer(
          makeBackend({
            cancelActiveExecution: Effect.sync(() => {
              cancellationRequests += 1;
              return {
                kind: "requested" as const,
                message: `Cancelling run ${runId}`,
              };
            }),
            executeOperation: (_operation, observer) => {
              executionAttempts += 1;

              if (executionAttempts > 1) {
                return Effect.fail("Another migration is already running");
              }

              observer.onStateChange({
                adapter: "inline",
                definitionId: articlesId,
                kind: "running",
                runId,
              });
              return Deferred.await(terminal).pipe(
                Effect.as({
                  message: `Run ${runId} succeeded`,
                  outcome: "completed" as const,
                  runId,
                })
              );
            },
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          target: { definitionId: articlesId, kind: "migration" as const },
        };
        const operation = yield* server.prepareOperation(request);
        const active = yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });

        const concurrentStartError = yield* Effect.flip(
          server.startOperation({
            acceptedFingerprint: operation.fingerprint,
            request,
          })
        );

        expect(concurrentStartError).toMatchObject({
          code: "operation-failed",
          message: "Another migration is already running",
        });
        expect(executionAttempts).toBe(1);
        expect(
          yield* server.cancelExecution({ executionId: active.executionId })
        ).toEqual({
          kind: "requested",
          message: `Cancelling run ${runId}`,
        });
        expect(cancellationRequests).toBe(1);

        yield* Deferred.succeed(terminal, undefined);
      })
  );
});
