import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateActiveRun,
  MigratePlanChangedError,
  type MigratePreparedOperation,
  type MigrateServerInfo,
} from "../protocol/index.ts";
import {
  MigrateServer,
  type MigrateServerBackend,
  type MigrateServerExecutionHandle,
  type MigrateServerExecutionObserver,
  type MigrateServerExecutionResult,
} from "./service.ts";

const articlesId = MigrationDefinitionId.make("articles");
const runId = MigrationRunId.make("run-1");
const secondRunId = MigrationRunId.make("run-2");
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
  stopSupported: false,
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
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
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

const executionHandle = (
  result: Effect.Effect<MigrateServerExecutionResult, unknown>,
  stop: MigrateServerExecutionHandle["stop"] = Effect.succeed({ kind: "idle" })
): Effect.Effect<MigrateServerExecutionHandle> =>
  Effect.succeed({ result, stop });

const makeBackend = (input?: {
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
  executeOperation:
    input?.executeOperation ??
    (() =>
      executionHandle(
        Effect.succeed({
          message: `Run ${runId} succeeded`,
          outcome: "completed",
          runId,
        })
      )),
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
      const server = yield* makeServer(
        makeBackend({
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
              return executionHandle(
                Deferred.await(terminal).pipe(
                  Effect.as({
                    message: `Run ${runId} succeeded`,
                    outcome: "completed" as const,
                    runId,
                  })
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

  it.effect("interrupts owned execution fibers when its scope closes", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makeServer(
            makeBackend({
              executeOperation: (_operation, observer) =>
                executionHandle(
                  Effect.sync(() =>
                    observer.onStateChange({
                      adapter: "inline",
                      definitionId: articlesId,
                      kind: "running",
                      runId,
                    })
                  ).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Deferred.succeed(interrupted, undefined)
                    )
                  )
                ),
            })
          );
          const request = {
            action: "run" as const,
            options: {},
            target: { definitionId: articlesId, kind: "migration" as const },
          };
          const operation = yield* server.prepareOperation(request);

          yield* server.startOperation({
            acceptedFingerprint: operation.fingerprint,
            request,
          });
        })
      );

      yield* Deferred.await(interrupted);
    })
  );

  it.effect(
    "observes a server-owned inline execution by run id without invoking durable observation",
    () =>
      Effect.gen(function* () {
        const terminal = yield* Deferred.make<void>();
        let durableObservationRequests = 0;
        const server = yield* makeServer(
          makeBackend({
            executeOperation: (_operation, observer) => {
              observer.onStateChange({
                adapter: "inline",
                definitionId: articlesId,
                kind: "running",
                runId,
              });
              return executionHandle(
                Deferred.await(terminal).pipe(
                  Effect.as({
                    message: `Run ${runId} succeeded`,
                    outcome: "completed" as const,
                    runId,
                  })
                )
              );
            },
            observeRun: () => {
              durableObservationRequests += 1;
              return Effect.die("Durable observation must not be used");
            },
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          target: { definitionId: articlesId, kind: "migration" as const },
        };
        const operation = yield* server.prepareOperation(request);
        yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });
        const observation = yield* server
          .observeRun({ runId })
          .pipe(Stream.runCollect, Effect.forkChild);

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
          {
            kind: "terminal",
            message: `Run ${runId} succeeded`,
            outcome: "completed",
            runId,
          },
        ]);
        expect(durableObservationRequests).toBe(0);
      })
  );

  it.effect("stops only the requested server-owned run", () =>
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<void>();
      let cancellationRequests = 0;
      const server = yield* makeServer(
        makeBackend({
          executeOperation: (_operation, observer) => {
            observer.onStateChange({
              adapter: "inline",
              definitionId: articlesId,
              kind: "running",
              runId,
            });
            return executionHandle(
              Deferred.await(terminal).pipe(
                Effect.as({
                  message: `Run ${runId} succeeded`,
                  outcome: "completed" as const,
                  runId,
                })
              ),
              Effect.sync(() => {
                cancellationRequests += 1;
                return {
                  kind: "requested" as const,
                  message: `Cancelling run ${runId}`,
                };
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
      yield* server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request,
      });

      const another = yield* server.stopRun({
        runId: MigrationRunId.make("another-run"),
      });
      expect(another).toEqual({
        kind: "not-running",
        message: "Run another-run is not running",
        runId: "another-run",
      });
      expect(cancellationRequests).toBe(0);
      const stopped = yield* server.stopRun({ runId });
      expect(stopped).toEqual({
        kind: "requested",
        message: `Cancelling run ${runId}`,
        runId,
      });
      expect(cancellationRequests).toBe(1);
      yield* Deferred.succeed(terminal, undefined);
    })
  );

  it.effect("reports provider-owned run cancellation as unsupported", () =>
    Effect.gen(function* () {
      const server = yield* makeServer(
        makeBackend({ getActiveRuns: Effect.succeed([activeRun]) })
      );

      const stopped = yield* server.stopRun({ runId });
      expect(stopped).toEqual({
        kind: "unsupported",
        message: `Run ${runId} cannot be stopped by this Migrate Server`,
        runId,
      });
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

              return executionHandle(
                Effect.succeed({
                  message: `Run ${runId} continues in the background`,
                  outcome: "detached" as const,
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

  it.effect("owns concurrent executions independently", () =>
    Effect.gen(function* () {
      const firstTerminal = yield* Deferred.make<void>();
      const secondTerminal = yield* Deferred.make<void>();
      const cancellationRequests = new Map<MigrationRunId, number>();
      let executionAttempts = 0;
      const server = yield* makeServer(
        makeBackend({
          executeOperation: (_operation, observer) => {
            executionAttempts += 1;
            const currentRunId = executionAttempts === 1 ? runId : secondRunId;
            const terminal =
              executionAttempts === 1 ? firstTerminal : secondTerminal;

            observer.onStateChange({
              adapter: "inline",
              definitionId: articlesId,
              kind: "running",
              runId: currentRunId,
            });
            return executionHandle(
              Deferred.await(terminal).pipe(
                Effect.as({
                  message: `Run ${currentRunId} succeeded`,
                  outcome: "completed" as const,
                  runId: currentRunId,
                })
              ),
              Effect.sync(() => {
                cancellationRequests.set(
                  currentRunId,
                  (cancellationRequests.get(currentRunId) ?? 0) + 1
                );
                return {
                  kind: "requested" as const,
                  message: `Cancelling run ${currentRunId}`,
                };
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
      const first = yield* server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request,
      });
      const second = yield* server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request,
      });

      expect(first.runId).toBe(runId);
      expect(second.runId).toBe(secondRunId);
      expect(second.executionId).not.toBe(first.executionId);
      expect(executionAttempts).toBe(2);
      expect(yield* server.stopRun({ runId })).toEqual({
        kind: "requested",
        message: `Cancelling run ${runId}`,
        runId,
      });
      expect(cancellationRequests.get(runId)).toBe(1);
      expect(cancellationRequests.get(secondRunId)).toBeUndefined();

      yield* Deferred.succeed(firstTerminal, undefined);
      yield* Deferred.succeed(secondTerminal, undefined);
    })
  );
});
