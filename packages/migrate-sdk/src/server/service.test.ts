import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeDashboardProjection } from "../client/internal/progress-projection.ts";
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
import type { MigrationDefinitionStatus } from "../domain/status.ts";
import { MigrationStatusRequestError } from "../domain/status.ts";
import {
  type MigrateActiveRun,
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
    "keeps final reconciliation resumable while another run publishes",
    () =>
      Effect.gen(function* () {
        for (const replaceServer of [false, true]) {
          const second = {
            ...activeRun,
            runId: secondRunId,
            observationDefinitionId: MigrationDefinitionId.make("authors"),
            definitionIds: [MigrationDefinitionId.make("authors")] as const,
          };
          let active: readonly MigrateActiveRun[] = [activeRun, second];
          const status: MigrationDefinitionStatus = {
            definitionId: articlesId,
            discovery: "incremental",
            durable: { migrated: 12, failed: 0, skipped: 0, needsUpdate: 0 },
            completion: null,
            lastRun: null,
            lock: null,
            warnings: [],
          };
          const dashboard = {
            activeRuns: active,
            groups: [],
            rows: [
              {
                entry: {
                  id: articlesId,
                  hasRollback: false,
                  dependencies: { required: [], optional: [] },
                },
                status,
              },
            ],
            scannedSource: false,
          };
          const final = runProgress([
            { ...status, durable: { ...status.durable, migrated: 100 } },
          ]);
          const projection = makeDashboardProjection();
          const received = yield* Queue.unbounded<MigrateDashboardSnapshot>();
          const reading = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const attached =
            yield* Deferred.make<
              NonNullable<
                import("../services/migration-executable.ts").MigrationExecutableObservationOptions["onEvent"]
              >
            >();
          const backend = makeBackend({
            getDashboard: Effect.succeed(dashboard),
            getRegistry: Effect.succeed({
              groups: [],
              entries: dashboard.rows.map(({ entry }) => entry),
            }),
            getActiveRuns: Effect.sync(() => active),
            getRunProgress: () =>
              Deferred.succeed(reading, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(final)
              ),
            watchDashboardRun: (run, options) =>
              Effect.gen(function* () {
                if (
                  run.runId === secondRunId &&
                  options.onEvent !== undefined
                ) {
                  yield* Deferred.succeed(attached, options.onEvent);
                }
                return yield* Effect.never;
              }),
          });
          const server = yield* MigrateServer.make({
            backend,
            ...serverIdentity,
            dashboardProjectionInterval: 0,
          });
          const observer = yield* server.observeDashboard({}).pipe(
            Stream.map(projection.apply),
            Stream.runForEach((snapshot) => Queue.offer(received, snapshot)),
            Effect.forkChild
          );
          yield* Queue.take(received);
          const send = yield* Deferred.await(attached);
          active = [second];
          yield* server.getDashboard;
          yield* TestClock.adjust(0);
          yield* Deferred.await(reading);
          yield* send({
            kind: "state-changed",
            runId: secondRunId,
            definitionIds: second.definitionIds,
            cursor: "7",
          });
          const beforeFinal = yield* Queue.take(received);
          expect(
            beforeFinal.dashboard.activeRuns.map((run) => run.runId)
          ).toContain(runId);
          expect(projection.resume()?.map((run) => run.runId)).toContain(runId);
          if (replaceServer) {
            yield* Fiber.interrupt(observer);
            let finalReads = 0;
            const replacement = yield* MigrateServer.make({
              ...serverIdentity,
              backend: {
                ...backend,
                getDashboard: Effect.die(
                  "must resume without a full dashboard read"
                ),
                getRunProgress: (id) =>
                  Effect.sync(() => {
                    expect(id).toBe(runId);
                    finalReads += 1;
                    return final;
                  }),
              },
            });
            const frames = yield* replacement
              .observeDashboard({ resume: projection.resume() ?? [] })
              .pipe(
                Stream.take(1),
                Stream.map(projection.apply),
                Stream.runCollect
              );
            expect(frames[0]?.dashboard.rows[0]?.status?.durable.migrated).toBe(
              100
            );
            expect(finalReads).toBe(1);
          } else {
            yield* Deferred.succeed(release, undefined);
            const completed = yield* Queue.take(received);
            expect(
              completed.dashboard.activeRuns.map((run) => run.runId)
            ).toEqual([secondRunId]);
            expect(completed.dashboard.rows[0]?.status?.durable.migrated).toBe(
              100
            );
            expect(projection.resume()?.map((run) => run.runId)).toEqual([
              secondRunId,
            ]);
            yield* Fiber.interrupt(observer);
          }
        }
      })
  );

  it.effect(
    "refreshes metadata once at renewal and coalesces lifecycle changes during replay",
    () =>
      Effect.gen(function* () {
        let metadataReads = 0;
        const completion = {
          definitionId: articlesId,
          runId,
          completedAt: new Date("2026-09-18T12:00:00Z"),
          sourceCursor: null,
        };
        let currentCompletion: typeof completion | null = null;
        const status: MigrationDefinitionStatus = {
          definitionId: articlesId,
          discovery: "incremental",
          durable: { migrated: 12, failed: 0, skipped: 0, needsUpdate: 0 },
          completion: null,
          lastRun: null,
          lock: null,
          warnings: [],
        };
        const entry = {
          id: articlesId,
          hasRollback: false,
          dependencies: { required: [], optional: [] },
        };
        const server = yield* MigrateServer.make({
          ...serverIdentity,
          backend: {
            ...makeBackend({
              getDashboard: Effect.die(
                "must not scan item summaries on renewal"
              ),
              getRegistry: Effect.succeed({ groups: [], entries: [entry] }),
              getActiveRuns: Effect.succeed([activeRun]),
              watchDashboardRun: (_run, options) =>
                Effect.gen(function* () {
                  currentCompletion = completion;
                  for (const cursor of ["1", "2", "3"]) {
                    yield* options.onEvent?.({
                      kind: "state-changed",
                      runId,
                      definitionIds: [articlesId],
                      cursor,
                      replaying: true,
                    }) ?? Effect.void;
                  }
                  yield* options.onEvent?.({
                    kind: "progress",
                    runId,
                    cursor: "4",
                    replaying: false,
                    progress: {
                      kind: "snapshot",
                      runId,
                      partitionId: "a:1",
                      revision: 1,
                      changes: [],
                    },
                  }) ?? Effect.void;
                  return yield* Effect.never;
                }),
            }),
            getDefinitionMetadata: (ids) =>
              Effect.sync(() => {
                metadataReads += ids.length;
                return ids.map((definitionId) => ({
                  definitionId,
                  completion: currentCompletion,
                  lastRun: null,
                  lock: null,
                }));
              }),
          },
        });
        const projection = makeDashboardProjection();
        const snapshot = yield* makeServer(
          makeBackend({
            getDashboard: Effect.succeed({
              activeRuns: [activeRun],
              rows: [{ entry, status }],
              groups: [],
              scannedSource: false,
            }),
          })
        ).pipe(Effect.flatMap((initial) => initial.getDashboard));
        projection.apply(snapshot);
        const frames = yield* server
          .observeDashboard({ resume: projection.resume() ?? [] })
          .pipe(
            Stream.take(5),
            Stream.map(projection.apply),
            Stream.runCollect
          );
        expect(frames[0]?.dashboard.rows[0]?.status?.completion).toBeNull();
        expect(frames.at(-1)?.dashboard.rows[0]?.status?.completion).toEqual(
          completion
        );
        expect(metadataReads).toBe(2);
      })
  );

  it.effect(
    "relays progress and discovers lifecycle changes without rescanning item states",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let finalReads = 0;
        let active = true;
        const attached =
          yield* Deferred.make<
            NonNullable<
              import("../services/migration-executable.ts").MigrationExecutableObservationOptions["onEvent"]
            >
          >();
        const finished = yield* Deferred.make<void>();
        const received = yield* Queue.unbounded<MigrateDashboardSnapshot>();
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
            getActiveRuns: Effect.sync(() => (active ? [activeRun] : [])),
            getRunProgress: () =>
              Effect.sync(() => {
                finalReads += 1;
                return runProgress([]);
              }),
            watchDashboardRun: (_run, options) =>
              Effect.gen(function* () {
                if (options.onEvent !== undefined) {
                  yield* Deferred.succeed(attached, options.onEvent);
                }
                yield* Deferred.await(finished);
              }),
          }),
          ...serverIdentity,
        });
        const observer = yield* server.observeDashboard({}).pipe(
          Stream.runForEach((snapshot) => Queue.offer(received, snapshot)),
          Effect.forkChild
        );
        yield* Queue.take(received);
        const send = yield* Deferred.await(attached);
        yield* send({
          kind: "progress",
          runId,
          cursor: "7",
          progress: {
            kind: "snapshot",
            runId,
            partitionId: "window-a",
            revision: 1,
            changes: [],
          },
        });
        expect((yield* Queue.take(received)).progress?.cursor).toBe("7");
        yield* TestClock.adjust("2 minutes");
        expect(reads).toBe(1);
        expect(finalReads).toBe(0);
        active = false;
        yield* Deferred.succeed(finished, undefined);
        yield* TestClock.adjust("2 seconds");
        expect(finalReads).toBe(1);
        expect(reads).toBe(1);
        yield* Fiber.interrupt(observer);
      })
  );

  it.effect(
    "waits for durable completion after a provider settles without repeated summary scans",
    () =>
      Effect.gen(function* () {
        let active = true;
        let reads = 0;
        let attachments = 0;
        const received = yield* Queue.unbounded<MigrateDashboardSnapshot>();
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.succeed({
              activeRuns: [activeRun],
              groups: [],
              rows: [],
              scannedSource: false,
            }),
            getActiveRuns: Effect.sync(() => (active ? [activeRun] : [])),
            getRunProgress: () =>
              Effect.sync(() => {
                reads += 1;
                return runProgress([]);
              }),
            watchDashboardRun: () =>
              Effect.sync(() => {
                attachments += 1;
              }),
          }),
          ...serverIdentity,
        });
        const observer = yield* server.observeDashboard({}).pipe(
          Stream.runForEach((snapshot) => Queue.offer(received, snapshot)),
          Effect.forkChild
        );
        yield* Queue.take(received);
        yield* TestClock.adjust("2 minutes");
        expect(attachments).toBe(1);
        expect(reads).toBe(0);
        active = false;
        yield* TestClock.adjust("35 seconds");
        expect(reads).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(reads).toBe(1);
        expect(attachments).toBe(1);
        yield* Fiber.interrupt(observer);
      })
  );

  it.effect(
    "reattaches a failed provider reader from its cursor without rereading item summaries",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let attempts = 0;
        const retried = yield* Deferred.make<string | undefined>();
        const received = yield* Queue.unbounded<MigrateDashboardSnapshot>();
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
            getActiveRuns: Effect.succeed([activeRun]),
            getRunProgress: () =>
              Effect.die(
                "must not reconcile a reader failure as run completion"
              ),
            watchDashboardRun: (_run, options) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts === 1) {
                  yield* options.onEvent?.({
                    kind: "progress",
                    runId,
                    cursor: "8",
                    progress: {
                      kind: "snapshot",
                      runId,
                      partitionId: "a:1",
                      revision: 1,
                      changes: [],
                    },
                  }) ?? Effect.void;
                  return yield* Effect.fail("temporary provider failure");
                }
                yield* Deferred.succeed(retried, options.after);
                return yield* Effect.never;
              }),
          }),
          ...serverIdentity,
        });
        const observer = yield* server.observeDashboard({}).pipe(
          Stream.runForEach((snapshot) => Queue.offer(received, snapshot)),
          Effect.forkChild
        );
        yield* Queue.take(received);
        yield* Queue.take(received);
        yield* TestClock.adjust("3 seconds");
        expect(yield* Deferred.await(retried)).toBe("8");
        expect(reads).toBe(1);
        expect(attempts).toBe(2);
        yield* Fiber.interrupt(observer);
      })
  );

  it.live(
    "broadcasts explicit lock changes to every subscriber using metadata reads",
    () =>
      Effect.gen(function* () {
        let reads = 0;
        let metadataReads = 0;
        const lock: MigrationDefinitionLock = {
          definitionId: articlesId,
          ownerRunId: runId,
          createdAt: new Date("2026-09-18T12:00:00Z"),
          token: MigrationDefinitionLockToken.make("orphan-lock"),
        };
        let currentLock: MigrationDefinitionLock | null = lock;
        const status: MigrationDefinitionStatus = {
          definitionId: articlesId,
          discovery: "incremental",
          durable: { migrated: 12, failed: 0, skipped: 0, needsUpdate: 0 },
          completion: null,
          lastRun: null,
          lock,
          warnings: [],
        };
        const server = yield* MigrateServer.make({
          backend: {
            ...makeBackend({
              breakLock: () =>
                Effect.sync(() => {
                  currentLock = null;
                  return { kind: "cleared" as const, definitionId: articlesId };
                }),
              getDashboard: Effect.sync(() => {
                reads += 1;
                return {
                  activeRuns: [],
                  groups: [],
                  rows: [
                    {
                      entry: {
                        id: articlesId,
                        hasRollback: false,
                        dependencies: { required: [], optional: [] },
                      },
                      status,
                    },
                  ],
                  scannedSource: false,
                };
              }),
            }),
            getDefinitionMetadata: (ids) =>
              Effect.sync(() => {
                metadataReads += ids.length;
                return ids.map((definitionId) => ({
                  definitionId,
                  completion: null,
                  lastRun: null,
                  lock: currentLock,
                }));
              }),
          },
          ...serverIdentity,
          dashboardProjectionInterval: 0,
        });
        const first = yield* Queue.unbounded<MigrateDashboardSnapshot>();
        const second = yield* Queue.unbounded<MigrateDashboardSnapshot>();
        for (const received of [first, second]) {
          const projection = makeDashboardProjection();
          yield* server.observeDashboard({}).pipe(
            Stream.map(projection.apply),
            Stream.runForEach((snapshot) => Queue.offer(received, snapshot)),
            Effect.forkChild
          );
          expect(
            (yield* Queue.take(received)).dashboard.rows[0]?.status?.lock
          ).toEqual(lock);
        }
        yield* server.breakLock({ lock });
        for (const received of [first, second]) {
          const updated = yield* Queue.take(received).pipe(
            Effect.timeout("2 seconds")
          );
          expect(updated.dashboard.rows[0]?.status?.lock).toBeNull();
          expect(updated.dashboard.rows[0]?.status?.durable).toEqual(
            status.durable
          );
        }
        expect(reads).toBe(2);
        expect(metadataReads).toBe(2);
      })
  );

  it.effect(
    "a replacement dashboard server resumes provider cursors without loading the dashboard",
    () =>
      Effect.gen(function* () {
        const attached = yield* Deferred.make<string | undefined>();
        const server = yield* MigrateServer.make({
          backend: makeBackend({
            getDashboard: Effect.die("must not rescan on renewal"),
            getActiveRuns: Effect.succeed([activeRun]),
            watchDashboardRun: (_run, options) =>
              Deferred.succeed(attached, options.after).pipe(
                Effect.andThen(Effect.never)
              ),
          }),
          ...serverIdentity,
        });
        const observer = yield* server
          .observeDashboard({
            resume: [
              { runId, observationDefinitionId: articlesId, cursor: "19" },
            ],
          })
          .pipe(Stream.runDrain, Effect.forkChild);
        expect(yield* Deferred.await(attached)).toBe("19");
        yield* Fiber.interrupt(observer);
      })
  );

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
