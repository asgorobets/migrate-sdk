import {
  Cause,
  Context,
  Deferred,
  Effect,
  FiberSet,
  Layer,
  Queue,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect/Scope";
import type { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationMessage } from "../domain/message.ts";
import type { MigrationDefinitionStatus } from "../domain/status.ts";
import {
  type MigrateActiveRun,
  type MigrateBreakLockResult,
  type MigrateCancellationResult,
  type MigrateDashboard,
  MigrateExecutionId,
  MigrateExecutionNotFoundError,
  type MigrateExecutionReference,
  type MigrateExecutionState,
  type MigrateObservationEvent,
  MigrateOperationError,
  type MigrateOperationRequest,
  MigratePlanChangedError,
  MigratePlanFingerprint,
  type MigratePreparedOperation,
  MigrateProtocolError,
  type MigrateRunStopResult,
  type MigrateServerInfo,
  type MigrateSourceIdentityHistoryEntry,
  type MigrateTarget,
} from "../protocol/index.ts";

export type MigratePrepareOperationInput = MigrateOperationRequest;

export interface MigrateServerService {
  readonly breakLock: (input: {
    readonly lock: MigrationDefinitionLock;
  }) => Effect.Effect<MigrateBreakLockResult, MigrateProtocolError>;
  readonly cancelExecution: (input: {
    readonly executionId?: MigrateExecutionId | undefined;
  }) => Effect.Effect<MigrateCancellationResult, MigrateProtocolError>;
  readonly getActiveRuns: Effect.Effect<
    readonly MigrateActiveRun[],
    MigrateProtocolError
  >;
  readonly getDashboard: Effect.Effect<MigrateDashboard, MigrateProtocolError>;
  readonly getMessages: (input: {
    readonly target: MigrateTarget;
  }) => Effect.Effect<readonly MigrationMessage[], MigrateProtocolError>;
  readonly getServerInfo: Effect.Effect<MigrateServerInfo>;
  readonly getSourceIdentityHistory: (input: {
    readonly definitionId: MigrationDefinitionId;
  }) => Effect.Effect<
    readonly MigrateSourceIdentityHistoryEntry[],
    MigrateProtocolError
  >;
  readonly normalizeSourceIdentity: (input: {
    readonly definitionId: MigrationDefinitionId;
    readonly sourceIdentity: string;
  }) => Effect.Effect<string, MigrateProtocolError>;
  readonly observeExecution: (input: {
    readonly executionId: MigrateExecutionId;
  }) => Stream.Stream<MigrateObservationEvent, MigrateProtocolError>;
  readonly observeRun: (input: {
    readonly runId: MigrationRunId;
  }) => Stream.Stream<MigrateObservationEvent, MigrateProtocolError>;
  readonly prepareOperation: (
    input: MigratePrepareOperationInput
  ) => Effect.Effect<MigratePreparedOperation, MigrateProtocolError>;
  readonly scanSource: (input: {
    readonly concurrency?: number | undefined;
    readonly target: MigrateTarget;
  }) => Effect.Effect<MigrateDashboard, MigrateProtocolError>;
  readonly startOperation: (input: {
    readonly acceptedFingerprint: MigratePreparedOperation["fingerprint"];
    readonly request: MigrateOperationRequest;
  }) => Effect.Effect<MigrateExecutionReference, MigrateProtocolError>;
  readonly stopRun: (input: {
    readonly runId: MigrationRunId;
  }) => Effect.Effect<MigrateRunStopResult, MigrateProtocolError>;
}

export interface MigrateServerExecutionObserver {
  readonly onObservationWarning: (message: string) => void;
  readonly onProgress: (progress: {
    readonly definitions: readonly MigrationDefinitionStatus[];
  }) => void;
  readonly onProgressError: (cause: unknown) => void;
  readonly onStateChange: (state: MigrateExecutionState) => void;
}

export interface MigrateServerExecutionResult {
  readonly message: string;
  readonly outcome: "cancelled" | "completed" | "detached";
  readonly runId: MigrationRunId;
}

export interface MigrateServerExecutionHandle {
  readonly result: Effect.Effect<MigrateServerExecutionResult, unknown>;
  readonly stop: Effect.Effect<MigrateCancellationResult, unknown>;
}

export interface MigrateServerPreparedOperation<ExecutableOperation> {
  readonly executable: ExecutableOperation;
  readonly operation: Omit<MigratePreparedOperation, "fingerprint">;
}

export interface MigrateServerBackend<ExecutableOperation> {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Effect.Effect<MigrateBreakLockResult, unknown>;
  readonly executeOperation: (
    operation: ExecutableOperation,
    observer: MigrateServerExecutionObserver
  ) => Effect.Effect<MigrateServerExecutionHandle, unknown>;
  readonly getActiveRuns: Effect.Effect<readonly MigrateActiveRun[], unknown>;
  readonly getDashboard: Effect.Effect<MigrateDashboard, unknown>;
  readonly getMessages: (
    target: MigrateTarget
  ) => Effect.Effect<readonly MigrationMessage[], unknown>;
  readonly getSourceIdentityHistory: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<readonly MigrateSourceIdentityHistoryEntry[], unknown>;
  readonly normalizeSourceIdentity: (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ) => Effect.Effect<string, unknown>;
  readonly observeRun: (
    runId: MigrationRunId,
    observer: MigrateServerExecutionObserver
  ) => Effect.Effect<MigrateServerExecutionResult, unknown>;
  readonly prepareOperation: (
    input: MigrateOperationRequest
  ) => Effect.Effect<
    MigrateServerPreparedOperation<ExecutableOperation>,
    unknown
  >;
  readonly scanSource: (input: {
    readonly concurrency?: number | undefined;
    readonly target: MigrateTarget;
  }) => Effect.Effect<MigrateDashboard, unknown>;
}

export interface MigrateServerInput<ExecutableOperation> {
  readonly backend: MigrateServerBackend<ExecutableOperation>;
  readonly serverInfo: MigrateServerInfo;
}

interface ExecutionListener {
  readonly emit: (event: MigrateObservationEvent) => void;
  readonly end: () => void;
}

interface ExecutionRecord {
  closed: boolean;
  readonly events: MigrateObservationEvent[];
  readonly executionId: MigrateExecutionId;
  lifecycle?: MigrateExecutionReference["lifecycle"] | undefined;
  readonly listeners: Set<ExecutionListener>;
  observed: boolean;
  runId?: MigrationRunId | undefined;
  stop?: Effect.Effect<MigrateCancellationResult, unknown> | undefined;
}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }

  return String(cause);
};

const operationError = (
  cause: unknown,
  code: "execution-failed" | "operation-failed" = "operation-failed"
): MigrateProtocolError => {
  if (Schema.is(MigrateProtocolError)(cause)) {
    return cause;
  }

  return new MigrateOperationError({ code, message: errorMessage(cause) });
};

const fingerprintInput = (
  operation: Omit<MigratePreparedOperation, "fingerprint">
) => ({
  action: operation.action,
  dependencyChecks: operation.dependencyChecks.map((check) => ({
    dependencyId: check.dependencyId,
    requiredByDefinitionId: check.requiredByDefinitionId,
    satisfied: check.satisfied,
  })),
  plan: operation.plan,
  sourceIdentities: operation.sourceIdentities,
  target: operation.target,
});

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const makeExecutionId = Effect.sync(() => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return MigrateExecutionId.make(bytesToHex(bytes));
});

const fingerprint = (
  operation: Omit<MigratePreparedOperation, "fingerprint">
): Effect.Effect<MigratePlanFingerprint> =>
  Effect.gen(function* () {
    const serialized = yield* Schema.encodeEffect(
      Schema.fromJsonString(Schema.Unknown)
    )(fingerprintInput(operation)).pipe(Effect.orDie);
    const digest = yield* Effect.promise(() =>
      globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(serialized)
      )
    );

    return MigratePlanFingerprint.make(
      `sha256:${bytesToHex(new Uint8Array(digest))}`
    );
  });

const makeMigrationServerService = <ExecutableOperation>(
  { backend, serverInfo }: MigrateServerInput<ExecutableOperation>,
  runExecution: (effect: Effect.Effect<void>) => unknown
): MigrateServerService => {
  const executions = new Map<string, ExecutionRecord>();
  const executionsByRunId = new Map<string, ExecutionRecord>();

  const removeExecution = (record: ExecutionRecord) => {
    executions.delete(record.executionId);
    if (record.runId !== undefined) {
      executionsByRunId.delete(record.runId);
    }
  };

  const registerRun = (
    record: ExecutionRecord,
    runId: MigrationRunId,
    lifecycle: MigrateExecutionReference["lifecycle"]
  ) => {
    record.lifecycle = lifecycle;
    record.runId = runId;
    executionsByRunId.set(runId, record);
  };

  const stopSupported = (runId: MigrationRunId): boolean => {
    const record = executionsByRunId.get(runId);
    return record?.closed === false && record.lifecycle === "attached";
  };

  const decorateActiveRun = (run: MigrateActiveRun): MigrateActiveRun => ({
    ...run,
    stopSupported: stopSupported(run.runId),
  });

  const publish = (record: ExecutionRecord, event: MigrateObservationEvent) => {
    record.events.push(event);

    for (const listener of record.listeners) {
      listener.emit(event);
    }
  };

  const close = (record: ExecutionRecord) => {
    record.closed = true;

    for (const listener of record.listeners) {
      listener.end();
    }
    record.listeners.clear();
  };

  const observeRecord = (
    record: ExecutionRecord
  ): Stream.Stream<MigrateObservationEvent> => {
    record.observed = true;

    return Stream.callback<MigrateObservationEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          for (const event of record.events) {
            Queue.offerUnsafe(queue, event);
          }

          if (record.closed) {
            Queue.endUnsafe(queue);
            return;
          }

          const listener: ExecutionListener = {
            emit: (event) => Queue.offerUnsafe(queue, event),
            end: () => Queue.endUnsafe(queue),
          };
          record.listeners.add(listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            if (listener !== undefined) {
              record.listeners.delete(listener);
            }
            if (record.closed) {
              removeExecution(record);
            }
          })
      )
    );
  };

  const prepareExecutable = (
    input: MigratePrepareOperationInput
  ): Effect.Effect<
    MigrateServerPreparedOperation<ExecutableOperation>,
    MigrateProtocolError
  > => backend.prepareOperation(input).pipe(Effect.mapError(operationError));

  const prepare = (
    input: MigratePrepareOperationInput
  ): Effect.Effect<MigratePreparedOperation, MigrateProtocolError> =>
    Effect.flatMap(prepareExecutable(input), ({ operation }) =>
      Effect.map(fingerprint(operation), (planFingerprint) => ({
        ...operation,
        fingerprint: planFingerprint,
      }))
    );

  return {
    breakLock: ({ lock }) =>
      backend.breakLock(lock).pipe(Effect.mapError(operationError)),
    cancelExecution: ({ executionId }) =>
      Effect.gen(function* () {
        const stoppable = [...executions.values()].filter(
          (record) => !record.closed && record.stop !== undefined
        );
        let record: ExecutionRecord | undefined;

        if (executionId === undefined) {
          record = stoppable.length === 1 ? stoppable[0] : undefined;
        } else {
          record = executions.get(executionId);
        }

        if (executionId !== undefined && record === undefined) {
          return yield* new MigrateExecutionNotFoundError({
            executionId,
            message: `Execution was not found: ${executionId}`,
          });
        }

        if (executionId === undefined && stoppable.length > 1) {
          return yield* new MigrateOperationError({
            code: "operation-failed",
            message: "Execution id is required when multiple runs are active",
          });
        }

        if (
          record === undefined ||
          record.closed ||
          record.stop === undefined
        ) {
          return { kind: "idle" as const };
        }

        return yield* record.stop.pipe(Effect.mapError(operationError));
      }),
    getDashboard: backend.getDashboard.pipe(
      Effect.map((dashboard) => ({
        ...dashboard,
        activeRuns: dashboard.activeRuns.map(decorateActiveRun),
      })),
      Effect.mapError(operationError)
    ),
    getActiveRuns: backend.getActiveRuns.pipe(
      Effect.map((runs) => runs.map(decorateActiveRun)),
      Effect.mapError(operationError)
    ),
    getMessages: ({ target }) =>
      backend.getMessages(target).pipe(Effect.mapError(operationError)),
    getServerInfo: Effect.succeed(serverInfo),
    getSourceIdentityHistory: ({ definitionId }) =>
      backend
        .getSourceIdentityHistory(definitionId)
        .pipe(Effect.mapError(operationError)),
    normalizeSourceIdentity: ({ definitionId, sourceIdentity }) =>
      backend
        .normalizeSourceIdentity(definitionId, sourceIdentity)
        .pipe(Effect.mapError(operationError)),
    observeExecution: ({ executionId }) => {
      const record = executions.get(executionId);

      if (record === undefined) {
        return Stream.fail(
          new MigrateExecutionNotFoundError({
            executionId,
            message: `Execution was not found: ${executionId}`,
          })
        );
      }

      return observeRecord(record);
    },
    observeRun: ({ runId }) => {
      const owned = executionsByRunId.get(runId);

      if (owned !== undefined) {
        return observeRecord(owned);
      }

      return Stream.callback<MigrateObservationEvent, MigrateProtocolError>(
        (queue) =>
          backend
            .observeRun(runId, {
              onObservationWarning: (message) =>
                Queue.offerUnsafe(queue, { kind: "warning", message }),
              onProgress: ({ definitions }) =>
                Queue.offerUnsafe(queue, { definitions, kind: "progress" }),
              onProgressError: (cause) =>
                Queue.offerUnsafe(queue, {
                  kind: "warning",
                  message: `Unable to refresh live status: ${errorMessage(cause)}`,
                }),
              onStateChange: (state) =>
                Queue.offerUnsafe(queue, { kind: "state", state }),
            })
            .pipe(
              Effect.matchCause({
                onFailure: (cause) =>
                  Queue.failCauseUnsafe(
                    queue,
                    Cause.fail(
                      operationError(Cause.squash(cause), "execution-failed")
                    )
                  ),
                onSuccess: (result) => {
                  Queue.offerUnsafe(
                    queue,
                    result.outcome === "detached"
                      ? {
                          kind: "detached",
                          message: result.message,
                          runId: result.runId,
                        }
                      : {
                          kind: "terminal",
                          message: result.message,
                          outcome: result.outcome,
                          runId: result.runId,
                        }
                  );
                  Queue.endUnsafe(queue);
                },
              }),
              Effect.forkScoped
            )
      );
    },
    prepareOperation: prepare,
    scanSource: ({ concurrency, target }) =>
      backend
        .scanSource(
          concurrency === undefined ? { target } : { concurrency, target }
        )
        .pipe(Effect.mapError(operationError)),
    startOperation: ({ acceptedFingerprint, request }) =>
      Effect.gen(function* () {
        const currentPreparedOperation = yield* prepareExecutable(request);
        const currentFingerprint = yield* fingerprint(
          currentPreparedOperation.operation
        );

        if (currentFingerprint !== acceptedFingerprint) {
          return yield* new MigratePlanChangedError({
            acceptedFingerprint,
            currentFingerprint,
            message:
              "Migration state changed after confirmation; review the updated plan before running it",
          });
        }

        const executionId = yield* makeExecutionId;
        const started = yield* Deferred.make<
          MigrateExecutionReference,
          MigrateProtocolError
        >();
        const record: ExecutionRecord = {
          closed: false,
          executionId,
          events: [],
          listeners: new Set(),
          observed: false,
        };
        let reference: MigrateExecutionReference | undefined;
        let runId: MigrationRunId | undefined;
        executions.set(executionId, record);

        const resolveStart = (nextReference: MigrateExecutionReference) => {
          if (reference === undefined) {
            reference = nextReference;
            Deferred.doneUnsafe(started, Effect.succeed(nextReference));
          }
        };

        const backendExecution = yield* backend
          .executeOperation(currentPreparedOperation.executable, {
            onObservationWarning: (message) =>
              publish(record, { kind: "warning", message }),
            onProgress: ({ definitions }) =>
              publish(record, { definitions, kind: "progress" }),
            onProgressError: (cause) =>
              publish(record, {
                kind: "warning",
                message: `Unable to refresh live status: ${errorMessage(cause)}`,
              }),
            onStateChange: (state) => {
              publish(record, { kind: "state", state });

              if (state.kind === "running") {
                runId = state.runId;
                registerRun(record, state.runId, "attached");
                resolveStart({
                  adapter: state.adapter,
                  executionId,
                  lifecycle: "attached",
                  runId: state.runId,
                });
              } else if (state.kind === "observing") {
                runId = state.runId;
                registerRun(record, state.runId, "detached");
                resolveStart({
                  adapter: state.adapter,
                  executionId,
                  lifecycle: "detached",
                  providerExecutionId: state.executionId,
                  runId: state.runId,
                });
              }
            },
          })
          .pipe(
            Effect.tapError(() => Effect.sync(() => removeExecution(record))),
            Effect.onInterrupt(() =>
              Effect.sync(() => removeExecution(record))
            ),
            Effect.mapError(operationError)
          );
        record.stop = backendExecution.stop;
        const execution = backendExecution.result.pipe(
          Effect.matchCause({
            onFailure: (cause) => {
              const error = Cause.squash(cause);

              if (reference === undefined || runId === undefined) {
                removeExecution(record);
                Deferred.doneUnsafe(
                  started,
                  Effect.fail(operationError(error, "execution-failed"))
                );
                return;
              }

              publish(record, {
                kind: "terminal",
                message: errorMessage(error),
                outcome: "failed",
                runId,
              });
              close(record);
            },
            onSuccess: (result) => {
              runId = result.runId;
              if (record.runId === undefined) {
                registerRun(record, result.runId, "completed");
              }
              resolveStart({
                executionId,
                lifecycle: "completed",
                runId: result.runId,
              });
              publish(
                record,
                result.outcome === "detached"
                  ? {
                      kind: "detached",
                      message: result.message,
                      runId: result.runId,
                    }
                  : {
                      kind: "terminal",
                      message: result.message,
                      outcome: result.outcome,
                      runId: result.runId,
                    }
              );
              close(record);
            },
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (record.observed && record.listeners.size === 0) {
                removeExecution(record);
              }
            })
          )
        );
        runExecution(execution);

        return yield* Deferred.await(started);
      }),
    stopRun: ({ runId }) =>
      Effect.gen(function* () {
        const record = executionsByRunId.get(runId);

        if (
          record !== undefined &&
          record.closed === false &&
          record.lifecycle === "attached" &&
          record.stop !== undefined
        ) {
          const cancellation = yield* record.stop;

          if (cancellation.kind === "requested") {
            return { ...cancellation, runId };
          }
          if (cancellation.kind === "detached") {
            return {
              kind: "unsupported" as const,
              message: `Run ${runId} cannot be stopped by this Migrate Server`,
              runId,
            };
          }

          return {
            kind: "not-running" as const,
            message: `Run ${runId} is not running`,
            runId,
          };
        }

        const activeRuns = yield* backend.getActiveRuns;

        if (activeRuns.some((run) => run.runId === runId)) {
          return {
            kind: "unsupported" as const,
            message: `Run ${runId} cannot be stopped by this Migrate Server`,
            runId,
          };
        }

        return {
          kind: "not-running" as const,
          message: `Run ${runId} is not running`,
          runId,
        };
      }).pipe(Effect.mapError(operationError)),
  };
};

export class MigrateServer extends Context.Service<
  MigrateServer,
  MigrateServerService
>()("@migrate-sdk/server/MigrateServer") {
  static readonly make = <ExecutableOperation>(
    input: MigrateServerInput<ExecutableOperation>
  ): Effect.Effect<MigrateServerService, never, Scope> =>
    Effect.gen(function* () {
      const runExecution = yield* FiberSet.makeRuntime<never, void, never>();
      return makeMigrationServerService(input, runExecution);
    });

  static readonly layer = <ExecutableOperation>(
    input: MigrateServerInput<ExecutableOperation>
  ): Layer.Layer<MigrateServer> =>
    Layer.effect(MigrateServer, MigrateServer.make(input));
}
