import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
  MigrationDefinitionId,
  MigrationDefinitionLockToken,
  MigrationRunId,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateActiveRun,
  type MigrateDashboard,
  type MigrateDashboardSnapshot,
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

const serverInfo: MigrateServerInfo = {
  environment: { id: "local:/workspace", label: "Local" },
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  sdkVersion: "0.1.0",
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
  readonly breakLock?: MigrateServerBackend<FakeExecutableOperation>["breakLock"];
  readonly executeOperation?: MigrateServerBackend<FakeExecutableOperation>["executeOperation"];
  readonly getActiveRuns?: MigrateServerBackend<FakeExecutableOperation>["getActiveRuns"];
  readonly getDashboard?: MigrateServerBackend<FakeExecutableOperation>["getDashboard"];
  readonly getRunProgress?: MigrateServerBackend<FakeExecutableOperation>["getRunProgress"];
  readonly observeRun?: MigrateServerBackend<FakeExecutableOperation>["observeRun"];
  readonly prepareOperation?: MigrateServerBackend<FakeExecutableOperation>["prepareOperation"];
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
  getRunProgress: input?.getRunProgress ?? (() => Effect.sync(() => undefined)),
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
  ...(input?.watchDashboardRun === undefined
    ? {}
    : { watchDashboardRun: input.watchDashboardRun }),
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
    "resumes bounded observation leases after the last resume token",
    () =>
      Effect.gen(function* () {
        const observationStarted = yield* Deferred.make<void>();
        const thirdObservationStarted = yield* Deferred.make<void>();
        let observationCount = 0;
        let observer: MigrateServerExecutionObserver | undefined;
        let durableDefinitions: Parameters<
          MigrateServerExecutionObserver["onProgress"]
        >[0]["definitions"] = [];
        const progressLocators: Array<MigrationDefinitionId | undefined> = [];
        const observationLocators: Array<MigrationDefinitionId | undefined> =
          [];
        const server = yield* makeServer(
          makeBackend({
            getActiveRuns: Effect.die("lease must not list all active runs"),
            getDashboard: Effect.die("lease must not load the dashboard"),
            getRunProgress: (_requestedRunId, observationDefinitionId) => {
              progressLocators.push(observationDefinitionId);
              return Effect.succeed(runProgress(durableDefinitions));
            },
            observeRun: (
              _requestedRunId,
              nextObserver,
              observationDefinitionId
            ) => {
              observationCount += 1;
              observationLocators.push(observationDefinitionId);
              observer = nextObserver;
              const started = Deferred.succeed(
                observationStarted,
                undefined
              ).pipe(
                Effect.andThen(
                  observationCount === 2
                    ? Deferred.succeed(thirdObservationStarted, undefined)
                    : Effect.void
                )
              );

              return started.pipe(Effect.andThen(Effect.never));
            },
          })
        );
        const initial = yield* server.observeRunLease({ runId });

        expect(initial.kind).toBe("continuing");
        if (initial.kind !== "continuing") {
          return;
        }
        const initialResumeToken = initial.nextResumeToken;
        expect(initial.events).toHaveLength(1);
        expect(initial.events[0]?.event).toEqual({
          definitions: [],
          kind: "progress",
        });
        expect(initialResumeToken).toBeDefined();

        const resumed = yield* server
          .observeRunLease({ after: initialResumeToken, runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(observationStarted);
        observer?.onStateChange({
          adapter: "workflow-sdk",
          definitionId: articlesId,
          executionId: "workflow-run-1",
          kind: "running",
          ownership: "provider",
          runId,
        });
        observer?.onObservationWarning("Following durable state");
        durableDefinitions = [
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
        ];
        observer?.onProgress({ definitions: durableDefinitions });
        const next = yield* Fiber.join(resumed);

        expect(next.kind).toBe("continuing");
        if (next.kind !== "continuing") {
          return;
        }
        expect(next.events.map((entry) => entry.event.kind)).toEqual([
          "state",
          "warning",
          "progress",
        ]);
        expect(next.nextResumeToken).not.toBe(initialResumeToken);
        expect(next.events.at(-1)?.event).toMatchObject({ kind: "progress" });
        expect(progressLocators).toEqual([undefined, articlesId]);
        expect(observationLocators).toEqual([articlesId]);

        const heartbeat = yield* server
          .observeRunLease({ after: next.nextResumeToken, runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(thirdObservationStarted);
        observer?.onObservationWarning("Following durable state");
        observer?.onProgress({ definitions: durableDefinitions });
        yield* TestClock.adjust("20 seconds");

        expect(yield* Fiber.join(heartbeat)).toEqual({ kind: "heartbeat" });
      })
  );

  it.effect(
    "delivers buffered server-owned lifecycle events once before resuming progress",
    () =>
      Effect.gen(function* () {
        let durableMigrated = 0;
        let observer: MigrateServerExecutionObserver | undefined;
        const progressLocators: Array<MigrationDefinitionId | undefined> = [];
        let progressRead: Deferred.Deferred<void> | undefined;
        const migrationStatus = () => ({
          definitionId: articlesId,
          discovery: "incremental" as const,
          durable: {
            failed: 0,
            migrated: durableMigrated,
            needsUpdate: 0,
            skipped: 0,
          },
          lastRun: null,
          lock: null,
          warnings: [],
        });
        const dashboardStatus = () => ({
          activeRuns: [activeRun],
          groups: [],
          rows: [
            {
              entry: {
                dependencies: { optional: [], required: [] },
                hasRollback: true,
                id: articlesId,
              },
              status: migrationStatus(),
            },
          ],
          scannedSource: false,
        });
        const backend = makeBackend({
          executeOperation: (_operation, nextObserver) => {
            observer = nextObserver;
            nextObserver.onStateChange({
              adapter: "inline",
              definitionId: articlesId,
              kind: "running",
              ownership: "server",
              runId,
            });
            nextObserver.onObservationWarning("Execution started inline");
            nextObserver.onProgress({ definitions: [migrationStatus()] });
            return executionHandle(Effect.never);
          },
          getActiveRuns: Effect.succeed([activeRun]),
          getDashboard: Effect.sync(dashboardStatus),
          getRunProgress: (_requestedRunId, observationDefinitionId) => {
            progressLocators.push(observationDefinitionId);
            if (progressRead !== undefined) {
              Deferred.doneUnsafe(progressRead, Effect.void);
            }
            return Effect.succeed(runProgress([migrationStatus()]));
          },
        });
        const server = yield* makeServer(backend);
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

        const initial = yield* server.observeRunLease({ runId });
        expect(initial.kind).toBe("continuing");
        if (initial.kind !== "continuing") {
          return;
        }
        let resumeToken = initial.nextResumeToken;
        expect(resumeToken).toBeDefined();
        expect(resumeToken.startsWith("execution:")).toBe(true);

        progressRead = yield* Deferred.make<void>();
        const bufferedLease = yield* server
          .observeRunLease({ after: resumeToken, runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(progressRead);
        progressRead = undefined;
        observer?.onProgress({ definitions: [migrationStatus()] });
        const buffered = yield* Fiber.join(bufferedLease);

        expect(progressLocators).toEqual([undefined, articlesId]);
        expect(buffered.kind).toBe("continuing");
        if (buffered.kind !== "continuing") {
          return;
        }
        expect(buffered.events.map((entry) => entry.event.kind)).toEqual([
          "state",
          "warning",
          "progress",
        ]);
        resumeToken = buffered.nextResumeToken;

        for (const migrated of [1, 2]) {
          progressRead = yield* Deferred.make<void>();
          const lease = yield* server
            .observeRunLease({ after: resumeToken, runId })
            .pipe(Effect.forkChild);
          yield* Deferred.await(progressRead);
          progressRead = undefined;
          durableMigrated = migrated;
          const publisher = yield* Effect.yieldNow.pipe(
            Effect.andThen(
              Effect.sync(() =>
                observer?.onProgress({ definitions: [migrationStatus()] })
              )
            ),
            Effect.forever,
            Effect.forkChild
          );
          const resumed = yield* Fiber.join(lease);
          yield* Fiber.interrupt(publisher);
          expect(resumed.kind).toBe("continuing");
          if (resumed.kind !== "continuing") {
            return;
          }
          expect(resumed.events.map((entry) => entry.event.kind)).toEqual([
            "progress",
          ]);
          expect(resumed.events.at(-1)?.event).toMatchObject({
            definitions: [{ durable: { migrated } }],
            kind: "progress",
          });
          resumeToken = resumed.nextResumeToken;
        }

        progressRead = yield* Deferred.make<void>();
        const thirdLease = yield* server
          .observeRunLease({ after: resumeToken, runId })
          .pipe(Effect.forkChild);
        yield* Deferred.await(progressRead);
        progressRead = undefined;
        durableMigrated = 3;
        const publisher = yield* Effect.yieldNow.pipe(
          Effect.andThen(
            Effect.sync(() =>
              observer?.onProgress({ definitions: [migrationStatus()] })
            )
          ),
          Effect.forever,
          Effect.forkChild
        );
        const third = yield* Fiber.join(thirdLease);
        yield* Fiber.interrupt(publisher);

        expect(third.kind).toBe("continuing");
        if (third.kind !== "continuing") {
          return;
        }
        expect(third.events[0]?.event).toMatchObject({
          definitions: [{ durable: { migrated: 3 } }],
          kind: "progress",
        });

        durableMigrated = 4;
        const replacement = yield* makeServer(backend);
        const replaced = yield* replacement.observeRunLease({
          after: third.nextResumeToken,
          runId,
        });

        expect(replaced.kind).toBe("continuing");
        if (replaced.kind !== "continuing") {
          return;
        }
        expect(replaced.events[0]?.event).toMatchObject({
          definitions: [{ durable: { migrated: 4 } }],
          kind: "progress",
        });
        expect(progressLocators).toEqual([
          undefined,
          articlesId,
          articlesId,
          articlesId,
          articlesId,
          articlesId,
        ]);
      })
  );

  it.effect("recovers changed durable progress after server replacement", () =>
    Effect.gen(function* () {
      let completed = false;
      let durableMigrated = 0;
      const getDashboard = Effect.sync(() => ({
        activeRuns: [activeRun],
        groups: [],
        rows: [
          {
            entry: {
              dependencies: { optional: [], required: [] },
              hasRollback: true,
              id: articlesId,
            },
            status: {
              definitionId: articlesId,
              discovery: "incremental" as const,
              durable: {
                failed: 0,
                migrated: durableMigrated,
                needsUpdate: 0,
                skipped: 0,
              },
              lastRun: null,
              lock: null,
              warnings: [],
            },
          },
        ],
        scannedSource: false,
      }));
      const backend = makeBackend({
        getActiveRuns: Effect.succeed([activeRun]),
        getDashboard,
        getRunProgress: () =>
          Effect.map(getDashboard, (current) =>
            runProgress(
              current.rows.flatMap((row) =>
                row.status === undefined ? [] : [row.status]
              )
            )
          ),
        observeRun: (requestedRunId) =>
          completed
            ? Effect.succeed({
                message: `Run ${requestedRunId} succeeded`,
                outcome: "completed" as const,
                runId: requestedRunId,
              })
            : Effect.never,
      });
      const original = yield* makeServer(backend);
      const initial = yield* original.observeRunLease({ runId });
      expect(initial.kind).toBe("continuing");
      if (initial.kind !== "continuing") {
        return;
      }

      durableMigrated = 1;
      const replacement = yield* makeServer(backend);
      const resumed = yield* replacement.observeRunLease({
        after: initial.nextResumeToken,
        runId,
      });

      expect(resumed.kind).toBe("continuing");
      if (resumed.kind !== "continuing") {
        return;
      }
      expect(resumed.events[0]?.event).toMatchObject({
        definitions: [{ durable: { migrated: 1 } }],
        kind: "progress",
      });

      completed = true;
      durableMigrated = 2;
      const finalProgress = yield* replacement.observeRunLease({
        after: resumed.nextResumeToken,
        runId,
      });

      expect(finalProgress.kind).toBe("continuing");
      if (finalProgress.kind !== "continuing") {
        return;
      }
      expect(finalProgress.events[0]?.event).toMatchObject({
        definitions: [{ durable: { migrated: 2 } }],
        kind: "progress",
      });

      const terminal = yield* replacement.observeRunLease({
        after: finalProgress.nextResumeToken,
        runId,
      });
      expect(terminal.kind).toBe("terminal");
    })
  );

  it.effect(
    "delivers final durable progress and lifecycle state before terminal completion",
    () =>
      Effect.gen(function* () {
        const server = yield* makeServer(
          makeBackend({
            getRunProgress: () => Effect.succeed(runProgress([])),
            observeRun: (requestedRunId, observer) => {
              observer.onStateChange({
                adapter: "workflow-sdk",
                definitionId: articlesId,
                executionId: "workflow-run-1",
                kind: "running",
                ownership: "provider",
                runId: requestedRunId,
              });

              return Effect.succeed({
                message: `Run ${requestedRunId} succeeded`,
                outcome: "completed" as const,
                runId: requestedRunId,
              });
            },
          })
        );
        const progress = yield* server.observeRunLease({ runId });

        expect(progress.kind).toBe("continuing");
        if (progress.kind !== "continuing") {
          return;
        }
        expect(progress.events.map((entry) => entry.event.kind)).toEqual([
          "progress",
        ]);

        const terminal = yield* server.observeRunLease({
          after: progress.nextResumeToken,
          runId,
        });

        expect(terminal.kind).toBe("terminal");
        if (terminal.kind !== "terminal") {
          return;
        }
        expect(terminal.events.map((entry) => entry.event.kind)).toEqual([
          "state",
        ]);
        expect(terminal.event.event).toMatchObject({
          kind: "terminal",
          outcome: "completed",
          runId,
        });
      })
  );

  it.effect("rejects terminal completion without durable progress", () =>
    Effect.gen(function* () {
      const server = yield* makeServer(makeBackend());
      const error = yield* Effect.flip(server.observeRunLease({ runId }));

      expect(error).toMatchObject({
        _tag: "MigrateOperationError",
        code: "operation-failed",
        message: `Unable to read final durable progress for Migration Run ${runId}`,
      });
    })
  );

  it.effect("returns a heartbeat when an observation lease has no update", () =>
    Effect.gen(function* () {
      const server = yield* MigrateServer.make({
        backend: makeBackend({ observeRun: () => Effect.never }),
        observationLeaseDuration: "1 second",
        serverInfo,
      });
      const lease = yield* server
        .observeRunLease({ runId })
        .pipe(Effect.forkChild);

      yield* TestClock.adjust("1 second");

      expect(yield* Fiber.join(lease)).toEqual({ kind: "heartbeat" });
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
          target: { definitionId: articlesId, kind: "migration" as const },
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
        target: { definitionId: articlesId, kind: "migration" as const },
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
          target: { definitionId: articlesId, kind: "migration" as const },
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
          serverInfo,
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
        serverInfo,
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
          serverInfo,
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
          dashboardProjectionInterval: "1 second",
          serverInfo,
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
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(slowReadStarted);

        dashboard = {
          ...dashboard,
          activeRuns: [activeRun, secondActiveRun],
        };
        yield* server.breakLock({ lock: definitionLock });
        yield* Deferred.succeed(releaseSlowRead, undefined);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const snapshots = yield* Fiber.join(snapshotsFiber);

        expect(maximumInFlightReads).toBe(1);
        expect(reads).toBe(3);
        expect(
          snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
        ).toEqual([[], [activeRun], [activeRun, secondActiveRun]]);
      })
  );

  it.effect(
    "discovers an externally started run through the fallback projection",
    () =>
      Effect.gen(function* () {
        const initialSnapshot = yield* Deferred.make<void>();
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
          dashboardFallbackInterval: "5 seconds",
          serverInfo,
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
        yield* TestClock.adjust("5 seconds");
        const snapshots = yield* Fiber.join(snapshotsFiber);

        expect(
          snapshots.map((snapshot) => snapshot.dashboard.activeRuns)
        ).toEqual([[], [activeRun]]);
      })
  );

  it.effect("reattaches a provider watcher after a transient failure", () =>
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
        dashboardFallbackInterval: "5 seconds",
        serverInfo,
      });
      const snapshotsFiber = yield* server.observeDashboard({}).pipe(
        Stream.tap(() => Deferred.succeed(initialSnapshot, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild
      );
      yield* Deferred.await(initialSnapshot);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(secondWatcherAttached);

      expect(watcherAttempts).toBe(2);

      dashboard = { ...dashboard, activeRuns: [] };
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
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
      const secondReadCompleted = yield* Deferred.make<void>();
      const thirdReadCompleted = yield* Deferred.make<void>();
      let dashboard: MigrateDashboard = {
        activeRuns: [],
        groups: [],
        rows: [],
        scannedSource: false,
      };
      let reads = 0;
      const server = yield* MigrateServer.make({
        backend: makeBackend({
          getDashboard: Effect.sync(() => {
            reads += 1;
            if (reads === 2) {
              Deferred.doneUnsafe(secondReadCompleted, Effect.void);
            }
            if (reads === 3) {
              Deferred.doneUnsafe(thirdReadCompleted, Effect.void);
            }
            return dashboard;
          }),
        }),
        dashboardFallbackInterval: "1 hour",
        dashboardProjectionInterval: "1 second",
        serverInfo,
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

      dashboard = { ...dashboard, activeRuns: [activeRun] };
      yield* server.breakLock({ lock: definitionLock });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(secondReadCompleted);

      dashboard = {
        ...dashboard,
        activeRuns: [activeRun, secondActiveRun],
      };
      yield* server.breakLock({ lock: definitionLock });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(thirdReadCompleted);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseSlowClient, undefined);
      const snapshots = yield* Fiber.join(snapshotsFiber);

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
          serverInfo,
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

  it.effect(
    "resumes a dashboard lease from durable state after server replacement",
    () =>
      Effect.gen(function* () {
        const original = yield* makeServer(
          makeBackend({
            getDashboard: Effect.succeed({
              activeRuns: [],
              groups: [],
              rows: [],
              scannedSource: false,
            }),
          })
        );
        const initial = yield* original.observeDashboardLease({});

        expect(initial.kind).toBe("snapshot");
        if (initial.kind !== "snapshot") {
          return;
        }

        const replacement = yield* makeServer(
          makeBackend({
            getDashboard: Effect.succeed({
              activeRuns: [activeRun],
              groups: [],
              rows: [],
              scannedSource: false,
            }),
          })
        );
        const resumed = yield* replacement.observeDashboardLease({
          after: initial.snapshot.resumeToken,
        });

        expect(resumed).toMatchObject({
          kind: "snapshot",
          snapshot: { dashboard: { activeRuns: [activeRun] } },
        });
      })
  );

  it.effect("returns a heartbeat when a dashboard lease has not changed", () =>
    Effect.gen(function* () {
      const server = yield* MigrateServer.make({
        backend: makeBackend(),
        dashboardFallbackInterval: "1 second",
        observationLeaseDuration: "5 seconds",
        serverInfo,
      });
      const initial = yield* server.observeDashboardLease({});

      expect(initial.kind).toBe("snapshot");
      if (initial.kind !== "snapshot") {
        return;
      }

      const heartbeatFiber = yield* server
        .observeDashboardLease({ after: initial.snapshot.resumeToken })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");

      expect(yield* Fiber.join(heartbeatFiber)).toEqual({ kind: "heartbeat" });
    })
  );
});
