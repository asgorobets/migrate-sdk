import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { MigrationStoreError, SourceError } from "../domain/errors.ts";
import {
  MigrationDefinitionGroupId,
  MigrationDefinitionId,
  MigrationDefinitionLockToken,
  MigrationRunId,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import {
  MigrationDefinitionRegistryUnknownDefinitionError,
  MigrationDefinitionRegistryUnknownGroupError,
} from "../domain/registry.ts";
import { MigrationStatusRequestError } from "../domain/status.ts";
import {
  type MigrateActiveRun,
  type MigrateDashboard,
  type MigrateDashboardSnapshot,
  MigratePlanChangedError,
  type MigratePreparedOperation,
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
const secondActiveRun: MigrateActiveRun = {
  ...activeRun,
  execution: {
    adapter: "workflow-sdk",
    executionId: "workflow-run-2",
  },
  runId: secondRunId,
};
const definitionLock: MigrationDefinitionLock = {
  createdAt: new Date("2026-08-25T12:00:00.000Z"),
  definitionId: articlesId,
  ownerRunId: runId,
  token: MigrationDefinitionLockToken.make("lock-1"),
};
const runProgress = (
  definitions: Parameters<
    MigrateServerExecutionObserver["onProgress"]
  >[0]["definitions"]
) => ({ definitions, observationDefinitionId: articlesId });

const serverIdentity = {
  environment: { id: "local:/workspace", label: "Local" },
};

interface FakeExecutableOperation {
  readonly executionDefinitionIds: readonly string[];
}

const preparedOperation = (
  executionDefinitionIds: readonly string[] = ["articles"]
): {
  readonly executable: FakeExecutableOperation;
  readonly operation: Omit<MigratePreparedOperation, "fingerprint" | "request">;
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
      executionPolicy: executionDefinitionIds.map((definitionId) => ({
        definitionId: MigrationDefinitionId.make(definitionId),
        discovery: "full" as const,
        processConcurrency: 1,
        rollbackConcurrency: 1,
      })),
      includedDefinitionIds: executionDefinitionIds.map((definitionId) =>
        MigrationDefinitionId.make(definitionId)
      ),
      notices: [],
      requestedDefinitionIds: [articlesId],
      withDependencies: false,
    },
    planRows: [],
    selection: { definitionIds: [articlesId], kind: "definitions" },
  },
});

const executionHandle = (
  result: Effect.Effect<MigrateServerExecutionResult, unknown>,
  stop: MigrateServerExecutionHandle["stop"] = Effect.succeed({ kind: "idle" })
): Effect.Effect<MigrateServerExecutionHandle> =>
  Effect.succeed({ result, stop });

const makeBackend = (input?: {
  readonly breakLock?: MigrateServerBackend<FakeExecutableOperation>["breakLock"];
  readonly executeOperation?: MigrateServerBackend<FakeExecutableOperation>["executeOperation"];
  readonly getActiveRuns?: MigrateServerBackend<FakeExecutableOperation>["getActiveRuns"];
  readonly getDashboard?: MigrateServerBackend<FakeExecutableOperation>["getDashboard"];
  readonly getRegistry?: MigrateServerBackend<FakeExecutableOperation>["getRegistry"];
  readonly getRegistryMessages?: MigrateServerBackend<FakeExecutableOperation>["getRegistryMessages"];
  readonly getRegistryStatus?: MigrateServerBackend<FakeExecutableOperation>["getRegistryStatus"];
  readonly getRunProgress?: MigrateServerBackend<FakeExecutableOperation>["getRunProgress"];
  readonly getSourceItemTotals?: MigrateServerBackend<FakeExecutableOperation>["getSourceItemTotals"];
  readonly observeRun?: MigrateServerBackend<FakeExecutableOperation>["observeRun"];
  readonly prepareOperation?: MigrateServerBackend<FakeExecutableOperation>["prepareOperation"];
  readonly stopRun?: MigrateServerBackend<FakeExecutableOperation>["stopRun"];
  readonly watchDashboardRun?: MigrateServerBackend<FakeExecutableOperation>["watchDashboardRun"];
}): MigrateServerBackend<FakeExecutableOperation> => ({
  breakLock:
    input?.breakLock ??
    ((lock: MigrationDefinitionLock) =>
      Effect.succeed({
        definitionId: lock.definitionId,
        kind: "cleared",
      })),
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
  getDashboard:
    input?.getDashboard ??
    Effect.succeed({
      activeRuns: [],
      groups: [],
      rows: [],
      scannedSource: false,
    }),
  getMessages: () => Effect.succeed([]),
  getRegistry:
    input?.getRegistry ?? Effect.succeed({ entries: [], groups: [] }),
  getRegistryMessages:
    input?.getRegistryMessages ??
    (() =>
      Effect.succeed({
        includedDefinitionIds: [],
        messages: [],
        notices: [],
        requestedDefinitionIds: "all",
      })),
  getRegistryStatus:
    input?.getRegistryStatus ??
    (() =>
      Effect.succeed({
        definitions: [],
        includedDefinitionIds: [],
        notices: [],
        requestedDefinitionIds: "all",
        scanSource: false,
        warnings: [],
      })),
  getRunProgress: input?.getRunProgress ?? (() => Effect.sync(() => undefined)),
  getSourceIdentityHistory: () => Effect.succeed([]),
  getSourceItemTotals: input?.getSourceItemTotals ?? (() => Effect.succeed([])),
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
  ...(input?.stopRun === undefined ? {} : { stopRun: input.stopRun }),
  ...(input?.watchDashboardRun === undefined
    ? {}
    : { watchDashboardRun: input.watchDashboardRun }),
});

const makeServer = (backend: MigrateServerBackend<FakeExecutableOperation>) =>
  MigrateServer.make({ backend, ...serverIdentity });

describe("Migrate Server", () => {
  it.effect("preserves typed operation planning errors", () =>
    Effect.gen(function* () {
      const errors = [
        new MigrationDefinitionRegistryUnknownDefinitionError({
          definitionId: MigrationDefinitionId.make("missing"),
          message: "Migration was not found",
        }),
        new MigrationDefinitionRegistryUnknownGroupError({
          group: MigrationDefinitionGroupId.make("missing-group"),
          message: "Migration group was not found",
        }),
      ] as const;

      for (const planningError of errors) {
        const server = yield* makeServer(
          makeBackend({
            prepareOperation: () => Effect.fail(planningError),
          })
        );
        const error = yield* server
          .prepareOperation({
            action: "run",
            options: {},
            selection: { kind: "all" },
          })
          .pipe(Effect.flip);

        expect(error).toEqual(planningError);
      }
    })
  );

  it.effect("preserves typed registry inspection errors", () =>
    Effect.gen(function* () {
      const statusError = new MigrationStatusRequestError({
        message:
          "Status concurrency is only valid when source scanning is enabled",
      });
      const server = yield* makeServer(
        makeBackend({
          getRegistryStatus: () => Effect.fail(statusError),
        })
      );
      const error = yield* server
        .getRegistryStatus({
          concurrency: 2,
          scanSource: false,
          selection: { kind: "all" },
          withDependencies: false,
        })
        .pipe(Effect.flip);

      expect(error).toEqual(statusError);

      const storeError = new MigrationStoreError({
        message: "Unable to read migration messages",
      });
      const sourceError = new SourceError({
        message: "Unable to scan source inventory",
      });
      const failingServer = yield* makeServer(
        makeBackend({
          getRegistryMessages: () => Effect.fail(storeError),
          getRegistryStatus: () => Effect.fail(sourceError),
        })
      );
      const messagesFailure = yield* failingServer
        .getRegistryMessages({
          selection: { kind: "all" },
          withDependencies: false,
        })
        .pipe(Effect.flip);
      const statusFailure = yield* failingServer
        .getRegistryStatus({
          scanSource: true,
          selection: { kind: "all" },
          withDependencies: false,
        })
        .pipe(Effect.flip);

      expect(messagesFailure).toEqual(storeError);
      expect(statusFailure).toEqual(sourceError);
    })
  );

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
              summary: {
                definitions: [
                  {
                    counts: {
                      failed: 0,
                      migrated: 1,
                      needsUpdate: 0,
                      skipped: 0,
                      unchanged: 0,
                    },
                    definitionId: articlesId,
                    status: "succeeded" as const,
                  },
                ],
                finishedAt: new Date("2026-08-29T12:01:00.000Z"),
                kind: "run" as const,
                runId,
                startedAt: new Date("2026-08-29T12:00:00.000Z"),
                status: "succeeded" as const,
              },
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
            summary: expect.objectContaining({
              kind: "run",
              status: "succeeded",
            }),
          },
        ]);
      })
  );

  it.effect(
    "preserves a failed terminal outcome after server replacement",
    () =>
      Effect.gen(function* () {
        const backend = makeBackend({
          getActiveRuns: Effect.succeed([activeRun]),
          observeRun: (requestedRunId) =>
            Effect.succeed({
              message: `Run ${requestedRunId} failed`,
              outcome: "failed" as const,
              runId: requestedRunId,
            }),
        });
        const replacementServer = yield* makeServer(backend);
        const events = yield* replacementServer
          .observeRun({ runId })
          .pipe(Stream.runCollect);

        expect(events.at(-1)).toEqual({
          kind: "terminal",
          message: `Run ${runId} failed`,
          outcome: "failed",
          runId,
        });
      })
  );

  it.effect(
    "delivers final durable progress and lifecycle state before terminal completion",
    () =>
      Effect.gen(function* () {
        let completed = false;
        const server = yield* makeServer(
          makeBackend({
            getRunProgress: () =>
              Effect.sync(() =>
                runProgress(
                  completed
                    ? [
                        {
                          definitionId: articlesId,
                          discovery: "incremental",
                          durable: {
                            failed: 0,
                            migrated: 1,
                            needsUpdate: 0,
                            skipped: 0,
                          },
                          lastRun: null,
                          lock: null,
                          warnings: [],
                        },
                      ]
                    : []
                )
              ),
            observeRun: (requestedRunId, observer) => {
              observer.onStateChange({
                adapter: "workflow-sdk",
                definitionId: articlesId,
                executionId: "workflow-run-1",
                kind: "running",
                ownership: "provider",
                runId: requestedRunId,
              });

              completed = true;
              return Effect.succeed({
                message: `Run ${requestedRunId} succeeded`,
                outcome: "completed" as const,
                runId: requestedRunId,
              });
            },
          })
        );
        const frames = yield* server
          .observeRunSession({ runId })
          .pipe(Stream.runCollect);
        const events = frames.flatMap((frame) => {
          if (frame.kind === "heartbeat") {
            return [];
          }
          return frame.kind === "terminal"
            ? [...frame.events, frame.event]
            : frame.events;
        });
        expect(events.map(({ event }) => event.kind)).toEqual([
          "progress",
          "state",
          "progress",
          "terminal",
        ]);
        expect(events.at(-2)?.event).toMatchObject({
          kind: "progress",
          definitions: [{ durable: { migrated: 1 } }],
        });
        expect(frames.at(-1)).toMatchObject({
          kind: "terminal",
          events: [{ event: { kind: "progress" } }],
        });
        expect(events.at(-1)?.event).toMatchObject({
          kind: "terminal",
          outcome: "completed",
          runId,
        });
      })
  );

  it.effect("rejects terminal completion without durable progress", () =>
    Effect.gen(function* () {
      const server = yield* makeServer(makeBackend());
      const error = yield* Effect.flip(
        server.observeRunSession({ runId }).pipe(Stream.runDrain)
      );

      expect(error).toMatchObject({
        _tag: "MigrateOperationError",
        code: "operation-failed",
        message: `Unable to read final durable progress for Migration Run ${runId}`,
      });
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
                ownership: "server",
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
          selection: {
            definitionIds: [articlesId] as const,
            kind: "definitions" as const,
          },
        };
        const operation = yield* server.prepareOperation(request);
        const reference = yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });

        expect(reference).toEqual({ runId, status: "started" });

        const observation = yield* server
          .observeRun({ runId: reference.runId })
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
              ownership: "server",
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
                      ownership: "server",
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
            selection: {
              definitionIds: [articlesId] as const,
              kind: "definitions" as const,
            },
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
                ownership: "server",
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
          selection: {
            definitionIds: [articlesId] as const,
            kind: "definitions" as const,
          },
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
              ownership: "server",
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

  it.effect("uses durable observation after synchronous completion", () =>
    Effect.gen(function* () {
      const server = yield* makeServer(
        makeBackend({
          executeOperation: (_operation, observer) => {
            observer.onStateChange({
              adapter: "inline",
              definitionId: articlesId,
              kind: "running",
              ownership: "server",
              runId,
            });

            return executionHandle(
              Effect.succeed({
                message: `Run ${runId} succeeded inline`,
                outcome: "completed" as const,
                runId,
              })
            );
          },
          observeRun: (requestedRunId, observer) => {
            observer.onObservationWarning("Following durable run state");

            return Effect.succeed({
              message: `Run ${requestedRunId} succeeded durably`,
              outcome: "completed" as const,
              runId: requestedRunId,
            });
          },
        })
      );
      const request = {
        action: "run" as const,
        options: {},
        selection: {
          definitionIds: [articlesId] as const,
          kind: "definitions" as const,
        },
      };
      const operation = yield* server.prepareOperation(request);
      const reference = yield* server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request,
      });
      yield* Effect.yieldNow;

      expect(reference).toEqual({ runId, status: "started" });
      expect(
        yield* server.observeRun({ runId }).pipe(Stream.runCollect)
      ).toEqual([
        { kind: "warning", message: "Following durable run state" },
        {
          kind: "terminal",
          message: `Run ${runId} succeeded durably`,
          outcome: "completed",
          runId,
        },
      ]);
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
              ownership: "server",
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
        selection: {
          definitionIds: [articlesId] as const,
          kind: "definitions" as const,
        },
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

  it.effect("delegates durable provider cancellation to the backend", () =>
    Effect.gen(function* () {
      const server = yield* makeServer(
        makeBackend({
          getActiveRuns: Effect.succeed([
            { ...activeRun, stopSupported: true },
          ]),
          stopRun: (requestedRunId) =>
            Effect.succeed(
              requestedRunId === runId
                ? {
                    kind: "requested" as const,
                    message: `Cancelling run ${requestedRunId}`,
                  }
                : { kind: "idle" as const }
            ),
        })
      );

      expect(yield* server.getActiveRuns).toEqual([
        expect.objectContaining({ runId, stopSupported: true }),
      ]);
      expect(yield* server.stopRun({ runId })).toEqual({
        kind: "requested",
        message: `Cancelling run ${runId}`,
        runId,
      });
    })
  );

  it.effect(
    "closes a detached observation without reporting the run as terminal",
    () =>
      Effect.gen(function* () {
        const detachedResult =
          yield* Deferred.make<MigrateServerExecutionResult>();
        const server = yield* makeServer(
          makeBackend({
            executeOperation: (_operation, observer) => {
              observer.onStateChange({
                adapter: "workflow",
                definitionId: articlesId,
                executionId: "workflow-1",
                kind: "running",
                ownership: "provider",
                runId,
              });

              return executionHandle(Deferred.await(detachedResult));
            },
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          selection: {
            definitionIds: [articlesId] as const,
            kind: "definitions" as const,
          },
        };
        const operation = yield* server.prepareOperation(request);
        const reference = yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });
        const observation = yield* server
          .observeRun({ runId: reference.runId })
          .pipe(Stream.runCollect, Effect.forkChild);
        const result: MigrateServerExecutionResult = {
          message: `Run ${runId} continues in the background`,
          outcome: "detached",
          runId,
        };
        yield* Deferred.succeed(detachedResult, result);
        const events = yield* Fiber.join(observation);

        expect(reference.status).toBe("started");
        expect(events).toEqual([
          {
            kind: "state",
            state: {
              adapter: "workflow",
              definitionId: articlesId,
              executionId: "workflow-1",
              kind: "running",
              ownership: "provider",
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

  it.effect("publishes durable provider cancellation to live observers", () =>
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<MigrateServerExecutionResult>();
      const server = yield* makeServer(
        makeBackend({
          executeOperation: (_operation, observer) => {
            observer.onStateChange({
              adapter: "workflow",
              definitionId: articlesId,
              executionId: "workflow-1",
              kind: "running",
              ownership: "provider",
              runId,
            });

            return executionHandle(Deferred.await(terminal));
          },
          stopRun: () =>
            Effect.succeed({
              kind: "requested" as const,
              message: `Cancelling run ${runId}`,
            }),
        })
      );
      const request = {
        action: "run" as const,
        options: {},
        selection: {
          definitionIds: [articlesId] as const,
          kind: "definitions" as const,
        },
      };
      const operation = yield* server.prepareOperation(request);
      yield* server.startOperation({
        acceptedFingerprint: operation.fingerprint,
        request,
      });
      const observation = yield* server
        .observeRun({ runId })
        .pipe(Stream.runCollect, Effect.forkChild);

      yield* Effect.yieldNow;
      expect(yield* server.stopRun({ runId })).toEqual({
        kind: "requested",
        message: `Cancelling run ${runId}`,
        runId,
      });
      yield* Deferred.succeed(terminal, {
        message: `Run ${runId} cancelled`,
        outcome: "cancelled" as const,
        runId,
      });

      expect(yield* Fiber.join(observation)).toContainEqual({
        kind: "state",
        state: {
          definitionId: articlesId,
          kind: "cancelling",
          runId,
        },
      });
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
          selection: {
            definitionIds: [articlesId] as const,
            kind: "definitions" as const,
          },
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
              ownership: "server",
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
        selection: {
          definitionIds: [articlesId] as const,
          kind: "definitions" as const,
        },
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

  it.effect(
    "coalesces dashboard invalidations into serialized absolute snapshots",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        const initialRead = yield* Deferred.make<void>();
        const initialSnapshot = yield* Deferred.make<void>();
        let dashboard: MigrateDashboard = {
          activeRuns: [],
          groups: [],
          rows: [],
          scannedSource: false,
        };
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.sync(() => {
              reads += 1;
              Deferred.doneUnsafe(initialRead, Effect.void);
              return dashboard;
            }),
          }),
          dashboardFallbackInterval: "1 hour",
          dashboardProjectionInterval: "1 second",
          ...serverIdentity,
        });
        const snapshotsFiber = yield* server.observeDashboard({}).pipe(
          Stream.tap(() => Deferred.succeed(initialSnapshot, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        );
        yield* Deferred.await(initialRead);
        yield* Deferred.await(initialSnapshot);

        expect(reads).toBe(1);
        dashboard = { ...dashboard, activeRuns: [activeRun] };
        yield* server.breakLock({ lock: definitionLock });
        dashboard = {
          ...dashboard,
          activeRuns: [activeRun, secondActiveRun],
        };
        yield* server.breakLock({ lock: definitionLock });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const snapshots = yield* Fiber.join(snapshotsFiber);

        expect(reads).toBe(2);
        expect(snapshots.map((snapshot) => snapshot.dashboard)).toEqual([
          { activeRuns: [], groups: [], rows: [], scannedSource: false },
          {
            activeRuns: [activeRun, secondActiveRun],
            groups: [],
            rows: [],
            scannedSource: false,
          },
        ]);
      })
  );

  it.effect("shares one dashboard projection across concurrent clients", () =>
    Effect.gen(function* () {
      let reads = 0;
      const server = yield* MigrateServer.make({
        backend: makeBackend({
          getDashboard: Effect.sync(() => {
            reads += 1;
            return {
              activeRuns: [],
              groups: [],
              rows: [],
              scannedSource: false,
            };
          }),
        }),
        ...serverIdentity,
      });

      const snapshots = yield* Effect.all(
        [
          server.observeDashboard({}).pipe(Stream.take(1), Stream.runCollect),
          server.observeDashboard({}).pipe(Stream.take(1), Stream.runCollect),
        ],
        { concurrency: "unbounded" }
      );

      expect(snapshots[0]).toEqual(snapshots[1]);
      expect(reads).toBe(1);
    })
  );

  it.effect(
    "uses a detached provider checkpoint only to trigger a durable read",
    () =>
      Effect.gen(function* () {
        const attached = yield* Deferred.make<Effect.Effect<void>>();
        const initialSnapshot = yield* Deferred.make<void>();
        let dashboard: MigrateDashboard = {
          activeRuns: [activeRun],
          groups: [],
          rows: [],
          scannedSource: false,
        };
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.sync(() => dashboard),
            watchDashboardRun: (_run, invalidate) =>
              Deferred.succeed(attached, invalidate).pipe(
                Effect.andThen(Effect.never)
              ),
          }),
          dashboardFallbackInterval: "1 hour",
          dashboardProjectionInterval: "1 second",
          ...serverIdentity,
        });
        const snapshotsFiber = yield* server.observeDashboard({}).pipe(
          Stream.tap(() => Deferred.succeed(initialSnapshot, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        );
        const invalidate = yield* Deferred.await(attached);
        yield* Deferred.await(initialSnapshot);

        dashboard = { ...dashboard, activeRuns: [] };
        yield* invalidate;
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const snapshots = yield* Fiber.join(snapshotsFiber);

        expect(
          snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
        ).toEqual([[activeRun], []]);
      })
  );

  it.effect(
    "serializes a dirty invalidation that arrives during a slow projection",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = yield* Deferred.make<void>();
        const slowReadStarted = yield* Deferred.make<void>();
        const releaseSlowRead = yield* Deferred.make<void>();
        let dashboard: MigrateDashboard = {
          activeRuns: [],
          groups: [],
          rows: [],
          scannedSource: false,
        };
        let inFlightReads = 0;
        let maximumInFlightReads = 0;
        let reads = 0;
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.gen(function* () {
              reads += 1;
              const readNumber = reads;
              const capturedDashboard = dashboard;
              inFlightReads += 1;
              maximumInFlightReads = Math.max(
                maximumInFlightReads,
                inFlightReads
              );
              const read =
                readNumber === 2
                  ? Deferred.succeed(slowReadStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(releaseSlowRead)),
                      Effect.as(capturedDashboard)
                    )
                  : Effect.succeed(capturedDashboard);

              return yield* read;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  inFlightReads -= 1;
                })
              )
            ),
          }),
          dashboardFallbackInterval: "1 hour",
          dashboardProjectionInterval: 0,
          ...serverIdentity,
        });
        const snapshotsFiber = yield* server.observeDashboard({}).pipe(
          Stream.tap(() => Deferred.succeed(initialSnapshot, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild
        );
        yield* Deferred.await(initialSnapshot);

        dashboard = { ...dashboard, activeRuns: [activeRun] };
        yield* server.breakLock({ lock: definitionLock });
        yield* Deferred.await(slowReadStarted);

        dashboard = {
          ...dashboard,
          activeRuns: [activeRun, secondActiveRun],
        };
        yield* server.breakLock({ lock: definitionLock });
        yield* Deferred.succeed(releaseSlowRead, undefined);
        const snapshots = yield* Fiber.join(snapshotsFiber);

        expect(maximumInFlightReads).toBe(1);
        expect(reads).toBe(3);
        expect(
          snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
        ).toEqual([[], [activeRun], [activeRun, secondActiveRun]]);
      })
  );

  it.effect(
    "reconciles external runs after thirty quiet seconds without five-second reads",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = yield* Deferred.make<void>();
        let reads = 0;
        let dashboard: MigrateDashboard = {
          activeRuns: [],
          groups: [],
          rows: [],
          scannedSource: false,
        };
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.sync(() => {
              reads += 1;
              return dashboard;
            }),
          }),
          ...serverIdentity,
        });
        const snapshotsFiber = yield* server.observeDashboard({}).pipe(
          Stream.tap(() => Deferred.succeed(initialSnapshot, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild
        );
        yield* Deferred.await(initialSnapshot);

        dashboard = { ...dashboard, activeRuns: [activeRun] };
        yield* Effect.yieldNow;
        yield* TestClock.adjust("29 seconds");
        expect(reads).toBe(1);
        yield* TestClock.adjust("1 second");
        const snapshots = yield* Fiber.join(snapshotsFiber);
        expect(reads).toBe(2);

        expect(
          snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
        ).toEqual([[], [activeRun]]);
      })
  );

  it.effect("backs off before reattaching a failed provider watcher", () =>
    Effect.gen(function* () {
      const initialSnapshot = yield* Deferred.make<void>();
      const secondWatcherAttached = yield* Deferred.make<void>();
      let watcherAttempts = 0;
      let dashboard: MigrateDashboard = {
        activeRuns: [activeRun],
        groups: [],
        rows: [],
        scannedSource: false,
      };
      const server = yield* MigrateServer.make({
        backend: makeBackend({
          getDashboard: Effect.sync(() => dashboard),
          watchDashboardRun: (_run, invalidate) => {
            watcherAttempts += 1;

            if (watcherAttempts === 1) {
              return invalidate.pipe(
                Effect.andThen(Effect.fail("provider stream unavailable"))
              );
            }

            return Deferred.succeed(secondWatcherAttached, undefined).pipe(
              Effect.andThen(Effect.never)
            );
          },
        }),
        ...serverIdentity,
      });
      const snapshotsFiber = yield* server.observeDashboard({}).pipe(
        Stream.tap(() => Deferred.succeed(initialSnapshot, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      );
      yield* Deferred.await(initialSnapshot);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("29 seconds");
      expect(watcherAttempts).toBe(1);
      yield* TestClock.adjust("2 seconds");
      // Explicit invalidation avoids racing the fallback timer with watcher cleanup.
      yield* server.breakLock({ lock: definitionLock });
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(secondWatcherAttached);

      expect(watcherAttempts).toBe(2);

      dashboard = { ...dashboard, activeRuns: [] };
      yield* Effect.yieldNow;
      yield* server.breakLock({ lock: definitionLock });
      yield* TestClock.adjust("1 second");
      const snapshots = yield* Fiber.join(snapshotsFiber);

      expect(
        snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
      ).toEqual([[activeRun], []]);
    })
  );

  it.effect("slides a slow dashboard client to the latest snapshot", () =>
    Effect.gen(function* () {
      const slowClientReceivedInitial = yield* Deferred.make<void>();
      const releaseSlowClient = yield* Deferred.make<void>();
      const fastClientReceivedInitial = yield* Deferred.make<void>();
      const firstSnapshotPublished = yield* Deferred.make<void>();
      const latestSnapshotPublished = yield* Deferred.make<void>();
      let dashboard: MigrateDashboard = {
        activeRuns: [],
        groups: [],
        rows: [],
        scannedSource: false,
      };
      const server = yield* MigrateServer.make({
        backend: makeBackend({
          getDashboard: Effect.sync(() => dashboard),
        }),
        dashboardFallbackInterval: "1 hour",
        dashboardProjectionInterval: 0,
        ...serverIdentity,
      });
      let receivedSnapshots = 0;
      const snapshotsFiber = yield* server.observeDashboard({}).pipe(
        Stream.tap(() => {
          receivedSnapshots += 1;

          return receivedSnapshots === 1
            ? Deferred.succeed(slowClientReceivedInitial, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSlowClient))
              )
            : Effect.void;
        }),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      );
      yield* Deferred.await(slowClientReceivedInitial);
      const fastClientFiber = yield* server.observeDashboard({}).pipe(
        Stream.runForEach((snapshot) => {
          const activeRunCount = snapshot.dashboard.activeRuns.length;

          if (activeRunCount === 0) {
            return Deferred.succeed(fastClientReceivedInitial, undefined);
          }

          if (activeRunCount === 1) {
            return Deferred.succeed(firstSnapshotPublished, undefined);
          }

          return Deferred.succeed(latestSnapshotPublished, undefined);
        }),
        Effect.forkChild
      );
      yield* Deferred.await(fastClientReceivedInitial);

      dashboard = { ...dashboard, activeRuns: [activeRun] };
      yield* server.breakLock({ lock: definitionLock });
      yield* Deferred.await(firstSnapshotPublished);

      dashboard = {
        ...dashboard,
        activeRuns: [activeRun, secondActiveRun],
      };
      yield* server.breakLock({ lock: definitionLock });
      yield* Deferred.await(latestSnapshotPublished);
      yield* Deferred.succeed(releaseSlowClient, undefined);
      const snapshots = yield* Fiber.join(snapshotsFiber);
      yield* Fiber.interrupt(fastClientFiber);

      expect(
        snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
      ).toEqual([[], [activeRun, secondActiveRun]]);
    })
  );

  it.effect(
    "does not replay an older shared projection after a versioned refresh",
    () =>
      Effect.gen(function* () {
        let dashboard: MigrateDashboard = {
          activeRuns: [],
          groups: [],
          rows: [],
          scannedSource: false,
        };
        const projected = yield* Queue.unbounded<MigrateDashboardSnapshot>();
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.sync(() => dashboard),
          }),
          dashboardFallbackInterval: "1 hour",
          dashboardProjectionInterval: "1 second",
          ...serverIdentity,
        });
        const keeper = yield* server.observeDashboard({}).pipe(
          Stream.runForEach((snapshot) => Queue.offer(projected, snapshot)),
          Effect.forkChild
        );
        yield* Queue.take(projected);

        dashboard = { ...dashboard, activeRuns: [activeRun] };
        yield* server.breakLock({ lock: definitionLock });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Queue.take(projected);

        dashboard = {
          ...dashboard,
          activeRuns: [activeRun, secondActiveRun],
        };
        const refreshed = yield* server.getDashboard;
        let resumed = false;
        const resumedFiber = yield* server
          .observeDashboard({ after: refreshed.resumeToken })
          .pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                resumed = true;
              })
            ),
            Stream.take(1),
            Stream.runHead,
            Effect.forkChild
          );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const projectedAfterRefresh = yield* Queue.take(projected);

        expect(projectedAfterRefresh.dashboard.activeRuns).toEqual([
          activeRun,
          secondActiveRun,
        ]);
        expect(resumed).toBe(false);

        dashboard = { ...dashboard, activeRuns: [] };
        yield* server.breakLock({ lock: definitionLock });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const resumedSnapshot = yield* Fiber.join(resumedFiber);

        expect(Option.getOrThrow(resumedSnapshot).dashboard.activeRuns).toEqual(
          []
        );
        yield* Fiber.interrupt(keeper);
      })
  );
});

describe("bounded HTTP observation sessions", () => {
  it.effect(
    "retains owned events produced during the snapshot read and detaches without stopping execution",
    () =>
      Effect.gen(function* () {
        const terminal = yield* Deferred.make<void>();
        let observer: MigrateServerExecutionObserver | undefined;
        let executionReleased = false;
        let publishDuringRead = true;
        const server = yield* makeServer(
          makeBackend({
            executeOperation: (_operation, nextObserver) => {
              observer = nextObserver;
              nextObserver.onStateChange({
                adapter: "inline",
                definitionId: articlesId,
                kind: "running",
                ownership: "server",
                runId,
              });
              return executionHandle(
                Deferred.await(terminal).pipe(
                  Effect.as({
                    outcome: "completed" as const,
                    runId,
                    message: "Finished",
                  }),
                  Effect.ensuring(
                    Effect.sync(() => {
                      executionReleased = true;
                    })
                  )
                )
              );
            },
            getRunProgress: () =>
              Effect.sync(() => {
                if (publishDuringRead) {
                  publishDuringRead = false;
                  observer?.onObservationWarning(
                    "Checkpoint committed during snapshot"
                  );
                  observer?.onProgress({ definitions: [] });
                }
                return runProgress([]);
              }),
          })
        );
        const request = {
          action: "run" as const,
          options: {},
          selection: {
            definitionIds: [articlesId] as const,
            kind: "definitions" as const,
          },
        };
        const operation = yield* server.prepareOperation(request);
        yield* server.startOperation({
          acceptedFingerprint: operation.fingerprint,
          request,
        });
        const checkpoints = yield* server.observeRunSession({ runId }).pipe(
          Stream.filter((frame) => frame.kind === "continuing"),
          Stream.take(2),
          Stream.runCollect
        );
        expect(
          checkpoints.map((frame) =>
            frame.events.map(({ event }) => event.kind)
          )
        ).toEqual([["progress"], ["warning"]]);
        expect(executionReleased).toBe(false);
        const after = checkpoints.at(-1)?.nextResumeToken;
        expect(after).toBeDefined();
        const resumed = yield* server.observeRunSession({ runId, after }).pipe(
          Stream.filter((frame) => frame.kind !== "heartbeat"),
          Stream.runCollect,
          Effect.forkChild
        );
        yield* Deferred.succeed(terminal, undefined);
        const events = yield* Fiber.join(resumed);
        expect(events.map((frame) => frame.kind)).toEqual([
          "continuing",
          "terminal",
        ]);
        expect(executionReleased).toBe(true);

        // A replacement instance must recover the locator from an owned cursor.
        expect(after?.startsWith("execution:")).toBe(true);
        const locators: Array<MigrationDefinitionId | undefined> = [];
        const replacement = yield* makeServer(
          makeBackend({
            getActiveRuns: Effect.die("must not list active runs"),
            getDashboard: Effect.die("must not read the dashboard"),
            getRunProgress: (_runId, definitionId) => {
              locators.push(definitionId);
              return Effect.succeed(runProgress([]));
            },
            observeRun: (_runId, _observer, definitionId) => {
              expect(definitionId).toBe(articlesId);
              return Effect.succeed({
                message: "Finished",
                outcome: "completed" as const,
                runId,
              });
            },
          })
        );
        const recovered = yield* replacement
          .observeRunSession({ runId, after })
          .pipe(
            Stream.filter((frame) => frame.kind !== "heartbeat"),
            Stream.runCollect
          );
        expect(recovered.map((frame) => frame.kind)).toEqual([
          "continuing",
          "terminal",
        ]);
        expect(locators).toEqual([articlesId, articlesId]);
      })
  );

  it.effect(
    "streams lifecycle and warnings immediately when no progress checkpoint follows",
    () =>
      Effect.gen(function* () {
        const server = yield* makeServer(
          makeBackend({
            getRunProgress: () => Effect.succeed(runProgress([])),
            observeRun: (_runId, observer) =>
              Effect.sync(() => {
                observer.onStateChange({
                  definitionId: articlesId,
                  kind: "cancelling",
                  runId,
                });
                observer.onObservationWarning("Provider is unavailable");
              }).pipe(Effect.andThen(Effect.never)),
          })
        );
        const events = yield* server.observeRunSession({ runId }).pipe(
          Stream.filter((frame) => frame.kind === "continuing"),
          Stream.take(3),
          Stream.runCollect
        );
        expect(
          events.flatMap((frame) => frame.events.map(({ event }) => event.kind))
        ).toEqual(["progress", "state", "warning"]);
      })
  );

  it.effect(
    "sends heartbeats without reading durable state and stops its provider watcher when the session ends",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let attached = 0;
        let detached = 0;
        const started = yield* Deferred.make<void>();
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.sync(() => {
              reads += 1;
              return {
                activeRuns: [activeRun],
                groups: [],
                rows: [],
                scannedSource: false,
              };
            }),
            watchDashboardRun: () =>
              Effect.sync(() => {
                attached += 1;
              }).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    detached += 1;
                  })
                )
              ),
          }),
          dashboardFallbackInterval: "1 hour",
          observationSessionDuration: "31 seconds",
          ...serverIdentity,
        });
        const observer = yield* server.observeDashboardSession({}).pipe(
          Stream.tap((event) =>
            event.kind === "snapshot"
              ? Deferred.succeed(started, undefined)
              : Effect.void
          ),
          Stream.runCollect,
          Effect.forkChild
        );
        yield* Deferred.await(started);
        yield* TestClock.adjust("31 seconds");
        const events = yield* Fiber.join(observer);
        expect(events.map((event) => event.kind)).toEqual([
          "heartbeat",
          "snapshot",
          "heartbeat",
          "heartbeat",
        ]);
        expect(reads).toBe(1);
        expect(attached).toBe(1);
        expect(detached).toBe(1);
        yield* TestClock.adjust("1 hour");
        expect(reads).toBe(1);
      })
  );
});
