import {
  Cause,
  Context,
  Deferred,
  Effect,
  FiberSet,
  Layer,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect/Scope";
import type { MigrationDefinitionId, MigrationRunId } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationMessage } from "../domain/message.ts";
import type { MigrationDefinitionStatus } from "../domain/status.ts";
import {
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

export interface MigrateServerPreparedOperation<ExecutableOperation> {
  readonly executable: ExecutableOperation;
  readonly operation: Omit<MigratePreparedOperation, "fingerprint">;
}

export interface MigrateServerBackend<ExecutableOperation> {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Effect.Effect<MigrateBreakLockResult, unknown>;
  readonly cancelActiveExecution: Effect.Effect<
    MigrateCancellationResult,
    unknown
  >;
  readonly executeOperation: (
    operation: ExecutableOperation,
    observer: MigrateServerExecutionObserver
  ) => Effect.Effect<MigrateServerExecutionResult, unknown>;
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
  readonly listeners: Set<ExecutionListener>;
  observed: boolean;
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
  runExecution: (effect: Effect.Effect<void>) => unknown,
  activeExecutionId: Ref.Ref<MigrateExecutionId | undefined>
): MigrateServerService => {
  const executions = new Map<string, ExecutionRecord>();

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
        const activeId = yield* Ref.get(activeExecutionId);
        const requestedExecutionId = executionId ?? activeId;

        if (
          requestedExecutionId !== undefined &&
          !executions.has(requestedExecutionId)
        ) {
          return yield* new MigrateExecutionNotFoundError({
            executionId: requestedExecutionId,
            message: `Execution was not found: ${requestedExecutionId}`,
          });
        }

        if (
          requestedExecutionId !== undefined &&
          requestedExecutionId !== activeId
        ) {
          return { kind: "idle" as const };
        }

        return yield* backend.cancelActiveExecution.pipe(
          Effect.mapError(operationError)
        );
      }),
    getDashboard: backend.getDashboard.pipe(Effect.mapError(operationError)),
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
                executions.delete(executionId);
              }
            })
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
        const claimed = yield* Ref.modify(activeExecutionId, (activeId) =>
          activeId === undefined ? [true, executionId] : [false, activeId]
        );

        if (!claimed) {
          return yield* new MigrateOperationError({
            code: "operation-failed",
            message: "Another migration is already running",
          });
        }

        const started = yield* Deferred.make<
          MigrateExecutionReference,
          MigrateProtocolError
        >();
        const record: ExecutionRecord = {
          closed: false,
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

        const execution = backend
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
                resolveStart({
                  adapter: state.adapter,
                  executionId,
                  lifecycle: "attached",
                  runId: state.runId,
                });
              } else if (state.kind === "observing") {
                runId = state.runId;
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
            Effect.matchCause({
              onFailure: (cause) => {
                const error = Cause.squash(cause);

                if (reference === undefined || runId === undefined) {
                  executions.delete(executionId);
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
              Ref.update(activeExecutionId, (activeId) =>
                activeId === executionId ? undefined : activeId
              ).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    if (record.observed && record.listeners.size === 0) {
                      executions.delete(executionId);
                    }
                  })
                )
              )
            )
          );
        runExecution(execution);

        return yield* Deferred.await(started);
      }),
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
      const activeExecutionId = yield* Ref.make<MigrateExecutionId | undefined>(
        undefined
      );
      return makeMigrationServerService(input, runExecution, activeExecutionId);
    });

  static readonly layer = <ExecutableOperation>(
    input: MigrateServerInput<ExecutableOperation>
  ): Layer.Layer<MigrateServer> =>
    Layer.effect(MigrateServer, MigrateServer.make(input));
}
