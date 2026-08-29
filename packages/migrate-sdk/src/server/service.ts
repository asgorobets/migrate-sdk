import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  FiberSet,
  Layer,
  Option,
  Queue,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { Scope } from "effect/Scope";
import {
  MigrationDefinitionId,
  type MigrationDefinitionRegistryId,
  type MigrationRunId,
} from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationMessage } from "../domain/message.ts";
import type { MigrationDefinitionStatus } from "../domain/status.ts";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateActiveRun,
  type MigrateBreakLockResult,
  MigrateDashboard,
  type MigrateDashboardLease,
  MigrateDashboardResumeToken,
  type MigrateDashboardSnapshot,
  type MigrateDefinitionIds,
  type MigrateDefinitionSourceItemTotal,
  type MigrateEnvironmentInfo,
  type MigrateExecutionState,
  type MigrateObservationContinuingEvent,
  MigrateObservationEvent,
  type MigrateObservationLease,
  MigrateObservationResumeToken,
  MigrateOperationError,
  type MigrateOperationRequest,
  MigratePlanChangedError,
  MigratePlanFingerprint,
  type MigratePreparedOperation,
  MigrateProtocolError,
  type MigrateRunStartResult,
  type MigrateRunStopResult,
  type MigrateServerInfo,
  type MigrateSourceIdentityHistoryEntry,
  type MigrateTarget,
} from "../protocol/index.ts";
import { MIGRATE_SDK_VERSION } from "../version.ts";

export type MigratePrepareOperationInput = MigrateOperationRequest;

export interface MigrateServerService {
  readonly breakLock: (input: {
    readonly lock: MigrationDefinitionLock;
  }) => Effect.Effect<MigrateBreakLockResult, MigrateProtocolError>;
  readonly getActiveRuns: Effect.Effect<
    readonly MigrateActiveRun[],
    MigrateProtocolError
  >;
  readonly getDashboard: Effect.Effect<
    MigrateDashboardSnapshot,
    MigrateProtocolError
  >;
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
  readonly getSourceItemTotals: (input: {
    readonly definitionIds: MigrateDefinitionIds;
  }) => Effect.Effect<
    readonly MigrateDefinitionSourceItemTotal[],
    MigrateProtocolError
  >;
  readonly normalizeSourceIdentity: (input: {
    readonly definitionId: MigrationDefinitionId;
    readonly sourceIdentity: string;
  }) => Effect.Effect<string, MigrateProtocolError>;
  readonly observeDashboard: (input: {
    readonly after?: MigrateDashboardResumeToken | undefined;
  }) => Stream.Stream<MigrateDashboardSnapshot, MigrateProtocolError>;
  readonly observeDashboardLease: (input: {
    readonly after?: MigrateDashboardResumeToken | undefined;
  }) => Effect.Effect<MigrateDashboardLease, MigrateProtocolError>;
  readonly observeRun: (input: {
    readonly runId: MigrationRunId;
  }) => Stream.Stream<MigrateObservationEvent, MigrateProtocolError>;
  readonly observeRunLease: (input: {
    readonly after?: MigrateObservationResumeToken | undefined;
    readonly runId: MigrationRunId;
  }) => Effect.Effect<MigrateObservationLease, MigrateProtocolError>;
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
  }) => Effect.Effect<MigrateRunStartResult, MigrateProtocolError>;
  readonly stopRun: (input: {
    readonly runId: MigrationRunId;
  }) => Effect.Effect<MigrateRunStopResult, MigrateProtocolError>;
}

export interface MigrateServerExecutionObserver {
  readonly onDashboardInvalidation: () => void;
  readonly onObservationWarning: (message: string) => void;
  readonly onProgress: (progress: {
    readonly definitions: readonly MigrationDefinitionStatus[];
  }) => void;
  readonly onProgressError: (cause: unknown) => void;
  readonly onStateChange: (state: MigrateExecutionState) => void;
}

export interface MigrateServerExecutionResult {
  readonly message: string;
  readonly outcome: "cancelled" | "completed" | "detached" | "failed";
  readonly runId: MigrationRunId;
}

export interface MigrateServerRunProgress {
  readonly definitions: readonly MigrationDefinitionStatus[];
  readonly observationDefinitionId: MigrationDefinitionId;
}

export interface MigrateServerExecutionHandle {
  readonly result: Effect.Effect<MigrateServerExecutionResult, unknown>;
  readonly stop: Effect.Effect<MigrateServerExecutionStopResult, unknown>;
}

export type MigrateServerExecutionStopResult =
  | { readonly kind: "idle" }
  | { readonly kind: "requested"; readonly message: string }
  | { readonly kind: "provider-owned"; readonly message: string };

export interface MigrateServerPreparedOperation<ExecutableOperation> {
  readonly executable: ExecutableOperation;
  readonly operation: Omit<MigratePreparedOperation, "fingerprint" | "request">;
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
  readonly getRunProgress: (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ) => Effect.Effect<MigrateServerRunProgress | undefined, unknown>;
  readonly getSourceIdentityHistory: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<readonly MigrateSourceIdentityHistoryEntry[], unknown>;
  readonly getSourceItemTotals: (
    definitionIds: MigrateDefinitionIds
  ) => Effect.Effect<readonly MigrateDefinitionSourceItemTotal[], unknown>;
  readonly normalizeSourceIdentity: (
    definitionId: MigrationDefinitionId,
    sourceIdentity: string
  ) => Effect.Effect<string, unknown>;
  readonly observeRun: (
    runId: MigrationRunId,
    observer: MigrateServerExecutionObserver,
    observationDefinitionId?: MigrationDefinitionId
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
  readonly stopRun?:
    | ((
        runId: MigrationRunId
      ) => Effect.Effect<MigrateServerExecutionStopResult, unknown>)
    | undefined;
  readonly watchDashboardRun?:
    | ((
        run: MigrateActiveRun,
        invalidate: Effect.Effect<void>
      ) => Effect.Effect<void, unknown>)
    | undefined;
}

export interface MigrateServerInput<ExecutableOperation> {
  readonly backend: MigrateServerBackend<ExecutableOperation>;
  readonly dashboardFallbackInterval?: Duration.Input | undefined;
  readonly dashboardProjectionInterval?: Duration.Input | undefined;
  readonly environment: MigrateEnvironmentInfo;
  readonly observationLeaseDuration?: Duration.Input | undefined;
  readonly registryId?: MigrationDefinitionRegistryId | undefined;
}

interface ExecutionListener {
  readonly emit: (event: MigrateObservationEvent, index: number) => void;
  readonly end: () => void;
}

interface IndexedExecutionEvent {
  readonly event: MigrateObservationEvent;
  readonly index: number;
}

interface ObservationEnvelope {
  readonly event: MigrateObservationEvent;
  readonly resumeToken: MigrateObservationResumeToken;
}

interface DashboardProjectionEnvelope extends MigrateDashboardSnapshot {
  readonly projectionSequence: number;
}

interface DashboardProjectionState {
  readonly isInitialProjection: boolean;
  readonly lastProjectionAt: number;
}

interface ContinuingObservationEnvelope extends ObservationEnvelope {
  readonly event: MigrateObservationContinuingEvent;
}

interface CompletionObservationEnvelope extends ObservationEnvelope {
  readonly event: Extract<
    MigrateObservationEvent,
    { readonly kind: "detached" | "terminal" }
  >;
}

interface BackendObservationResumePosition {
  readonly eventToken: MigrateObservationResumeToken;
  readonly observationDefinitionId: MigrationDefinitionId;
}

interface ExecutionObservationResumePosition
  extends BackendObservationResumePosition {
  readonly executionId: MigrateServerExecutionId;
  readonly index: number;
}

interface ExecutionRecord {
  closed: boolean;
  readonly events: MigrateObservationEvent[];
  readonly executionId: MigrateServerExecutionId;
  readonly listeners: Set<ExecutionListener>;
  readonly observationDefinitionId: MigrationDefinitionId;
  ownership?: "provider" | "server" | undefined;
  runId?: MigrationRunId | undefined;
  stop?: Effect.Effect<MigrateServerExecutionStopResult, unknown> | undefined;
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
  operation: Omit<MigratePreparedOperation, "fingerprint" | "request">
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

const MigrateServerExecutionId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrateServerExecutionId")
);
type MigrateServerExecutionId = typeof MigrateServerExecutionId.Type;

const makeExecutionId = Effect.sync(() => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return MigrateServerExecutionId.make(bytesToHex(bytes));
});

const fingerprint = (
  operation: Omit<MigratePreparedOperation, "fingerprint" | "request">
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

const observationResumeToken = (
  event: MigrateObservationEvent
): Effect.Effect<MigrateObservationResumeToken> =>
  Effect.gen(function* () {
    const serialized = yield* Schema.encodeEffect(
      Schema.fromJsonString(MigrateObservationEvent)
    )(event).pipe(Effect.orDie);
    const digest = yield* Effect.promise(() =>
      globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(serialized)
      )
    );

    return MigrateObservationResumeToken.make(
      `sha256:${bytesToHex(new Uint8Array(digest))}`
    );
  });

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
};

const sortActiveRunDefinitionIds = (
  definitionIds: MigrateActiveRun["definitionIds"]
): MigrateActiveRun["definitionIds"] => {
  const sorted = [...definitionIds].sort(compareText);
  const [first, ...rest] = sorted;

  return first === undefined ? definitionIds : [first, ...rest];
};

const canonicalDashboard = (dashboard: MigrateDashboard): MigrateDashboard => ({
  ...dashboard,
  activeRuns: dashboard.activeRuns
    .map((run) => ({
      ...run,
      definitionIds: sortActiveRunDefinitionIds(run.definitionIds),
    }))
    .sort((left, right) => compareText(left.runId, right.runId)),
  groups: dashboard.groups
    .map((group) => ({
      ...group,
      definitionIds: [...group.definitionIds].sort(compareText),
    }))
    .sort((left, right) => compareText(left.id, right.id)),
  rows: dashboard.rows
    .map((row) => ({
      ...row,
      entry: {
        ...row.entry,
        dependencies: {
          optional: [...row.entry.dependencies.optional].sort(compareText),
          required: [...row.entry.dependencies.required].sort(compareText),
        },
      },
    }))
    .sort((left, right) => compareText(left.entry.id, right.entry.id)),
});

const dashboardResumeToken = (
  dashboard: MigrateDashboard
): Effect.Effect<MigrateDashboardResumeToken> =>
  Effect.gen(function* () {
    const serialized = yield* Schema.encodeEffect(
      Schema.fromJsonString(MigrateDashboard)
    )(canonicalDashboard(dashboard)).pipe(Effect.orDie);
    const digest = yield* Effect.promise(() =>
      globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(serialized)
      )
    );

    return MigrateDashboardResumeToken.make(
      `sha256:${bytesToHex(new Uint8Array(digest))}`
    );
  });

const backendObservationResumeToken = (
  observationDefinitionId: MigrationDefinitionId,
  eventToken: MigrateObservationResumeToken
): MigrateObservationResumeToken =>
  MigrateObservationResumeToken.make(
    `backend:${encodeURIComponent(observationDefinitionId)}:${eventToken}`
  );

const backendObservationResumePosition = (
  resumeToken: MigrateObservationResumeToken | undefined
): BackendObservationResumePosition | undefined => {
  if (resumeToken === undefined || !resumeToken.startsWith("backend:")) {
    return;
  }

  const locatorStart = "backend:".length;
  const separator = resumeToken.indexOf(":", locatorStart);

  if (separator < locatorStart + 1) {
    return;
  }

  try {
    const observationDefinitionId = decodeURIComponent(
      resumeToken.slice(locatorStart, separator)
    );
    const eventToken = resumeToken.slice(separator + 1);

    if (
      !(
        Schema.is(MigrationDefinitionId)(observationDefinitionId) &&
        Schema.is(MigrateObservationResumeToken)(eventToken)
      )
    ) {
      return;
    }

    return {
      eventToken,
      observationDefinitionId,
    };
  } catch {
    return;
  }
};

const executionObservationResumeToken = (
  executionId: MigrateServerExecutionId,
  observationDefinitionId: MigrationDefinitionId,
  index: number,
  eventToken: MigrateObservationResumeToken
): MigrateObservationResumeToken =>
  MigrateObservationResumeToken.make(
    `execution:${executionId}:${encodeURIComponent(observationDefinitionId)}:${index}:${eventToken}`
  );

const beforeFirstExecutionEventIndex = -1;

const executionObservationResumePosition = (
  resumeToken: MigrateObservationResumeToken | undefined
): ExecutionObservationResumePosition | undefined => {
  if (resumeToken === undefined || !resumeToken.startsWith("execution:")) {
    return;
  }

  const executionStart = "execution:".length;
  const executionEnd = resumeToken.indexOf(":", executionStart);
  const definitionEnd = resumeToken.indexOf(":", executionEnd + 1);
  const indexEnd = resumeToken.indexOf(":", definitionEnd + 1);

  if (
    executionEnd < executionStart + 1 ||
    definitionEnd < executionEnd + 2 ||
    indexEnd < definitionEnd + 2
  ) {
    return;
  }

  try {
    const executionId = resumeToken.slice(executionStart, executionEnd);
    const observationDefinitionId = decodeURIComponent(
      resumeToken.slice(executionEnd + 1, definitionEnd)
    );
    const index = Number(resumeToken.slice(definitionEnd + 1, indexEnd));
    const eventToken = resumeToken.slice(indexEnd + 1);

    if (
      !(
        Schema.is(MigrateServerExecutionId)(executionId) &&
        Schema.is(MigrationDefinitionId)(observationDefinitionId) &&
        Number.isSafeInteger(index) &&
        index >= beforeFirstExecutionEventIndex &&
        Schema.is(MigrateObservationResumeToken)(eventToken)
      )
    ) {
      return;
    }

    return {
      eventToken,
      executionId,
      index,
      observationDefinitionId,
    };
  } catch {
    return;
  }
};

const resumeEventToken = (
  resumeToken: MigrateObservationResumeToken
): MigrateObservationResumeToken =>
  backendObservationResumePosition(resumeToken)?.eventToken ??
  executionObservationResumePosition(resumeToken)?.eventToken ??
  resumeToken;

const makeMigrationServerServiceWithInvalidationQueue = <ExecutableOperation>(
  {
    backend,
    dashboardFallbackInterval = "5 seconds",
    dashboardProjectionInterval = "1 second",
    environment,
    observationLeaseDuration = "20 seconds",
    registryId,
  }: MigrateServerInput<ExecutableOperation>,
  runExecution: (effect: Effect.Effect<void>) => unknown,
  dashboardInvalidations: Queue.Queue<void>,
  dashboardReadSemaphore: Semaphore.Semaphore
): Effect.Effect<MigrateServerService, never, Scope> => {
  const serverInfo: MigrateServerInfo = {
    environment,
    protocolVersion: MIGRATE_PROTOCOL_VERSION,
    ...(registryId === undefined ? {} : { registryId }),
    sdkVersion: MIGRATE_SDK_VERSION,
  };
  const executionsByRunId = new Map<string, ExecutionRecord>();
  const invalidateDashboardUnsafe = () => {
    Queue.offerUnsafe(dashboardInvalidations, undefined);
  };
  const invalidateDashboard = Effect.sync(invalidateDashboardUnsafe);

  const removeExecution = (record: ExecutionRecord) => {
    if (
      record.runId !== undefined &&
      executionsByRunId.get(record.runId) === record
    ) {
      executionsByRunId.delete(record.runId);
    }
  };

  const registerRun = (
    record: ExecutionRecord,
    runId: MigrationRunId,
    ownership: NonNullable<ExecutionRecord["ownership"]>
  ) => {
    record.ownership = ownership;
    record.runId = runId;
    executionsByRunId.set(runId, record);
  };

  const stopSupported = (runId: MigrationRunId): boolean => {
    const record = executionsByRunId.get(runId);
    return record?.closed === false && record.ownership === "server";
  };

  const decorateActiveRun = (run: MigrateActiveRun): MigrateActiveRun => ({
    ...run,
    stopSupported: run.stopSupported || stopSupported(run.runId),
  });

  const publish = (record: ExecutionRecord, event: MigrateObservationEvent) => {
    record.events.push(event);
    const index = record.events.length - 1;

    if (event.kind !== "warning") {
      invalidateDashboardUnsafe();
    }

    for (const listener of record.listeners) {
      listener.emit(event, index);
    }
  };

  const publishProviderCancellation = (
    record: ExecutionRecord | undefined,
    runId: MigrationRunId
  ) => {
    if (
      record === undefined ||
      record.closed ||
      record.ownership !== "provider"
    ) {
      return;
    }

    publish(record, {
      kind: "state",
      state: {
        definitionId: record.observationDefinitionId,
        kind: "cancelling",
        runId,
      },
    });
  };

  const close = (record: ExecutionRecord) => {
    record.closed = true;

    for (const listener of record.listeners) {
      listener.end();
    }
    record.listeners.clear();
  };

  const observeRecordEntriesFromIndex = (
    record: ExecutionRecord,
    startIndex: number
  ): Stream.Stream<IndexedExecutionEvent> =>
    Stream.callback<IndexedExecutionEvent>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          for (
            let index = startIndex;
            index < record.events.length;
            index += 1
          ) {
            const event = record.events[index];

            if (event !== undefined) {
              Queue.offerUnsafe(queue, { event, index });
            }
          }

          if (record.closed) {
            Queue.endUnsafe(queue);
            return;
          }

          const listener: ExecutionListener = {
            emit: (event, index) => Queue.offerUnsafe(queue, { event, index }),
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
          })
      )
    );

  const observeRecord = (
    record: ExecutionRecord
  ): Stream.Stream<MigrateObservationEvent> =>
    observeRecordEntriesFromIndex(record, 0).pipe(
      Stream.map(({ event }) => event)
    );

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
        request: input,
      }))
    );

  const readDashboard = backend.getDashboard.pipe(
    Effect.map((dashboard) => ({
      ...dashboard,
      activeRuns: dashboard.activeRuns.map(decorateActiveRun),
    })),
    Effect.mapError(operationError),
    dashboardReadSemaphore.withPermit
  );
  const readDashboardSnapshot = readDashboard.pipe(
    Effect.flatMap((dashboard) =>
      dashboardResumeToken(dashboard).pipe(
        Effect.map((resumeToken) => ({ dashboard, resumeToken }))
      )
    )
  );
  const getDashboard = readDashboardSnapshot.pipe(
    Effect.tap(invalidateDashboard)
  );
  const getActiveRuns = backend.getActiveRuns.pipe(
    Effect.map((runs) => runs.map(decorateActiveRun)),
    Effect.mapError(operationError)
  );
  const observeBackendRun = (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ): Stream.Stream<MigrateObservationEvent, MigrateProtocolError> =>
    Stream.callback<MigrateObservationEvent, MigrateProtocolError>((queue) =>
      backend
        .observeRun(
          runId,
          {
            onDashboardInvalidation: invalidateDashboardUnsafe,
            onObservationWarning: (message) =>
              Queue.offerUnsafe(queue, { kind: "warning", message }),
            onProgress: ({ definitions }) =>
              Queue.offerUnsafe(queue, {
                definitions,
                kind: "progress",
              }),
            onProgressError: (cause) =>
              Queue.offerUnsafe(queue, {
                kind: "warning",
                message: `Unable to refresh live status: ${errorMessage(cause)}`,
              }),
            onStateChange: (state) =>
              Queue.offerUnsafe(queue, { kind: "state", state }),
          },
          observationDefinitionId
        )
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

  const observeRun = ({
    runId,
  }: {
    readonly runId: MigrationRunId;
  }): Stream.Stream<MigrateObservationEvent, MigrateProtocolError> => {
    const owned = executionsByRunId.get(runId);

    if (owned !== undefined) {
      return observeRecord(owned);
    }

    return observeBackendRun(runId);
  };

  const initialRunProgress = (
    runId: MigrationRunId,
    observationDefinitionId?: MigrationDefinitionId
  ): Effect.Effect<
    MigrateServerRunProgress | undefined,
    MigrateProtocolError
  > =>
    backend
      .getRunProgress(runId, observationDefinitionId)
      .pipe(Effect.mapError(operationError));

  const envelope = <Event extends MigrateObservationEvent>(
    event: Event
  ): Effect.Effect<{
    readonly resumeToken: MigrateObservationResumeToken;
    readonly event: Event;
  }> =>
    observationResumeToken(event).pipe(
      Effect.map((resumeToken) => ({ resumeToken, event }))
    );

  const backendEnvelope = <Event extends MigrateObservationEvent>(
    observationDefinitionId: MigrationDefinitionId,
    event: Event
  ): Effect.Effect<{
    readonly resumeToken: MigrateObservationResumeToken;
    readonly event: Event;
  }> =>
    observationResumeToken(event).pipe(
      Effect.map((eventToken) => ({
        resumeToken: backendObservationResumeToken(
          observationDefinitionId,
          eventToken
        ),
        event,
      }))
    );

  const ownedObservationResumePosition = (
    record: ExecutionRecord,
    position: ExecutionObservationResumePosition | undefined
  ): ExecutionObservationResumePosition | undefined =>
    position?.executionId === record.executionId &&
    position.observationDefinitionId === record.observationDefinitionId
      ? position
      : undefined;

  const ownedObservationStartIndex = (
    record: ExecutionRecord,
    position:
      | {
          readonly eventToken: MigrateObservationResumeToken;
          readonly index: number;
        }
      | undefined
  ): number => {
    if (position !== undefined && position.index < record.events.length) {
      return position.index + 1;
    }

    if (record.closed) {
      for (let index = record.events.length - 1; index >= 0; index -= 1) {
        const event = record.events[index];

        if (event?.kind === "terminal" || event?.kind === "detached") {
          return index;
        }
      }
    }

    return record.events.length;
  };

  const ownedEnvelope = (
    record: ExecutionRecord,
    { event, index }: IndexedExecutionEvent
  ): Effect.Effect<{
    readonly resumeToken: MigrateObservationResumeToken;
    readonly event: MigrateObservationEvent;
  }> =>
    observationResumeToken(event).pipe(
      Effect.map((eventToken) => ({
        resumeToken: executionObservationResumeToken(
          record.executionId,
          record.observationDefinitionId,
          index,
          eventToken
        ),
        event,
      }))
    );

  const continuingLease = (
    events: readonly [
      ContinuingObservationEnvelope,
      ...ContinuingObservationEnvelope[],
    ]
  ): MigrateObservationLease => {
    const nextResumeToken = events.at(-1)?.resumeToken ?? events[0].resumeToken;

    return {
      events,
      kind: "continuing",
      nextResumeToken,
    };
  };

  const terminalLease = (
    completion: CompletionObservationEnvelope,
    events: readonly ContinuingObservationEnvelope[] = []
  ): MigrateObservationLease => ({
    event: completion,
    events,
    kind: "terminal",
  });

  const initialProgressEnvelope = (
    progress: MigrateServerRunProgress | undefined,
    owned: ExecutionRecord | undefined,
    ownedPosition: ExecutionObservationResumePosition | undefined
  ): Effect.Effect<ContinuingObservationEnvelope | undefined> => {
    if (progress === undefined) {
      return Effect.sync(() => undefined);
    }

    const event = {
      definitions: progress.definitions,
      kind: "progress" as const,
    } satisfies MigrateObservationContinuingEvent;

    return observationResumeToken(event).pipe(
      Effect.map((eventToken) => ({
        event,
        resumeToken:
          owned === undefined
            ? backendObservationResumeToken(
                progress.observationDefinitionId,
                eventToken
              )
            : executionObservationResumeToken(
                owned.executionId,
                progress.observationDefinitionId,
                ownedPosition?.index ?? beforeFirstExecutionEventIndex,
                eventToken
              ),
      }))
    );
  };

  const isContinuingEnvelope = (
    next: ObservationEnvelope
  ): next is ContinuingObservationEnvelope =>
    next.event.kind === "progress" ||
    next.event.kind === "state" ||
    next.event.kind === "warning";

  const isCompletionEnvelope = (
    next: ObservationEnvelope
  ): next is CompletionObservationEnvelope =>
    next.event.kind === "detached" || next.event.kind === "terminal";

  const isObservationCheckpoint = (next: ObservationEnvelope): boolean =>
    next.event.kind === "progress" ||
    next.event.kind === "terminal" ||
    next.event.kind === "detached";

  const leaseFromObservedEvents = (
    events: readonly ObservationEnvelope[]
  ): MigrateObservationLease => {
    const last = events.at(-1);

    if (
      last === undefined ||
      last.event.kind === "state" ||
      last.event.kind === "warning"
    ) {
      return { kind: "heartbeat" };
    }

    const continuingEvents = events.filter(isContinuingEnvelope);

    if (isCompletionEnvelope(last)) {
      return terminalLease(last, continuingEvents);
    }

    const first = continuingEvents[0];

    return first === undefined
      ? { kind: "heartbeat" }
      : continuingLease([first, ...continuingEvents.slice(1)]);
  };

  const observationResumePosition = (
    runId: MigrationRunId,
    after: MigrateObservationResumeToken | undefined
  ) => {
    const backendPosition = backendObservationResumePosition(after);
    const executionPosition = executionObservationResumePosition(after);
    const owned = executionsByRunId.get(runId);
    const ownedPosition =
      owned === undefined
        ? undefined
        : ownedObservationResumePosition(owned, executionPosition);
    const resumedExecutionPosition =
      owned === undefined ? executionPosition : ownedPosition;

    return {
      owned,
      ownedPosition,
      requestedObservationDefinitionId:
        backendPosition?.observationDefinitionId ??
        resumedExecutionPosition?.observationDefinitionId,
      seenEventToken:
        ownedPosition?.eventToken ??
        backendPosition?.eventToken ??
        resumedExecutionPosition?.eventToken ??
        after,
    };
  };

  const reconcileTerminalObservationLease = (
    runId: MigrationRunId,
    observationDefinitionId: MigrationDefinitionId | undefined,
    owned: ExecutionRecord | undefined,
    ownedPosition: ExecutionObservationResumePosition | undefined,
    seenEventToken: MigrateObservationResumeToken | undefined,
    observedLease: Extract<MigrateObservationLease, { kind: "terminal" }>
  ): Effect.Effect<MigrateObservationLease, MigrateProtocolError> =>
    Effect.gen(function* () {
      const finalProgress = yield* initialRunProgress(
        runId,
        observationDefinitionId
      );
      const finalEnvelope = yield* initialProgressEnvelope(
        finalProgress,
        owned,
        ownedPosition
      );

      if (
        finalEnvelope === undefined &&
        observedLease.event.event.kind === "terminal"
      ) {
        return yield* new MigrateOperationError({
          code: "operation-failed",
          message: `Unable to read final durable progress for Migration Run ${runId}`,
        });
      }

      const finalEventToken =
        finalEnvelope === undefined
          ? undefined
          : resumeEventToken(finalEnvelope.resumeToken);

      if (finalEnvelope === undefined || finalEventToken === seenEventToken) {
        return observedLease;
      }

      const firstContinuingEvent = observedLease.events[0];

      return firstContinuingEvent === undefined
        ? continuingLease([finalEnvelope])
        : continuingLease([
            firstContinuingEvent,
            ...observedLease.events.slice(1),
            finalEnvelope,
          ]);
    });

  const observeRunLease = ({
    after,
    runId,
  }: {
    readonly after?: MigrateObservationResumeToken | undefined;
    readonly runId: MigrationRunId;
  }): Effect.Effect<MigrateObservationLease, MigrateProtocolError> =>
    Effect.gen(function* () {
      const {
        owned,
        ownedPosition,
        requestedObservationDefinitionId,
        seenEventToken,
      } = observationResumePosition(runId, after);
      const initial = yield* initialRunProgress(
        runId,
        requestedObservationDefinitionId
      );
      const observationDefinitionId =
        initial?.observationDefinitionId ?? requestedObservationDefinitionId;
      const initialEnvelope = yield* initialProgressEnvelope(
        initial,
        owned,
        ownedPosition
      );
      const initialEventToken =
        initialEnvelope === undefined
          ? undefined
          : resumeEventToken(initialEnvelope.resumeToken);

      if (
        initialEnvelope !== undefined &&
        initialEventToken !== seenEventToken
      ) {
        return continuingLease([initialEnvelope]);
      }

      const observation =
        owned === undefined
          ? observeBackendRun(runId, observationDefinitionId).pipe(
              Stream.mapEffect((event) =>
                observationDefinitionId === undefined
                  ? envelope(event)
                  : backendEnvelope(observationDefinitionId, event)
              )
            )
          : observeRecordEntriesFromIndex(
              owned,
              ownedObservationStartIndex(owned, ownedPosition)
            ).pipe(Stream.mapEffect((entry) => ownedEnvelope(owned, entry)));
      const events = yield* observation.pipe(
        Stream.filter((next) => next.resumeToken !== after),
        Stream.takeUntil(isObservationCheckpoint),
        Stream.interruptWhen(Effect.sleep(observationLeaseDuration)),
        Stream.runCollect
      );
      const observedLease = leaseFromObservedEvents(events);

      if (observedLease.kind !== "terminal") {
        return observedLease;
      }

      return yield* reconcileTerminalObservationLease(
        runId,
        observationDefinitionId,
        owned,
        ownedPosition,
        seenEventToken,
        observedLease
      );
    });

  const dashboardProjectionIntervalMs = Duration.toMillis(
    dashboardProjectionInterval
  );
  let dashboardProjectionSequence = 0;
  const dashboardProjectionSource = Stream.unwrap(
    Effect.gen(function* () {
      const watcherFibers = yield* FiberMap.make<string, void, never>();
      const watcherKeys = new Set<string>();

      const dashboardWatcherKey = (
        run: MigrateActiveRun
      ): string | undefined => {
        const execution = run.execution;

        if (execution === undefined || executionsByRunId.has(run.runId)) {
          return;
        }

        return [run.runId, execution.adapter, execution.executionId]
          .map(encodeURIComponent)
          .join(":");
      };

      const removeInactiveDashboardWatchers = (
        activeWatcherKeys: ReadonlySet<string>
      ): Effect.Effect<void> =>
        [...watcherKeys]
          .filter((key) => !activeWatcherKeys.has(key))
          .reduce(
            (effect, key) =>
              effect.pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    watcherKeys.delete(key);
                  })
                ),
                Effect.andThen(FiberMap.remove(watcherFibers, key))
              ),
            Effect.void
          );

      const reconcileDashboardRuns = (
        runs: readonly MigrateActiveRun[]
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          const activeWatcherKeys = new Set<string>();

          if (backend.watchDashboardRun !== undefined) {
            for (const run of runs) {
              const key = dashboardWatcherKey(run);

              if (key === undefined) {
                continue;
              }

              activeWatcherKeys.add(key);

              if (watcherKeys.has(key)) {
                continue;
              }

              watcherKeys.add(key);
              const watcher = backend
                .watchDashboardRun(run, invalidateDashboard)
                .pipe(
                  Effect.ignore,
                  Effect.ensuring(
                    Effect.sync(() => {
                      watcherKeys.delete(key);
                    })
                  )
                );
              yield* FiberMap.run(watcherFibers, key, watcher, {
                onlyIfMissing: true,
                startImmediately: true,
              });
            }
          }

          yield* removeInactiveDashboardWatchers(activeWatcherKeys);
        });

      const waitForDashboardTrigger = Effect.raceFirst(
        Queue.take(dashboardInvalidations).pipe(Effect.asVoid),
        Effect.sleep(dashboardFallbackInterval)
      );

      return Stream.paginate<
        DashboardProjectionState,
        DashboardProjectionEnvelope,
        MigrateProtocolError
      >({ isInitialProjection: true, lastProjectionAt: 0 }, (state) =>
        Effect.gen(function* () {
          if (state.isInitialProjection) {
            yield* Queue.poll(dashboardInvalidations);
          } else {
            yield* waitForDashboardTrigger;
            const beforeDelay = yield* Clock.currentTimeMillis;
            const remainingDelay = Math.max(
              0,
              state.lastProjectionAt +
                dashboardProjectionIntervalMs -
                beforeDelay
            );

            if (remainingDelay > 0) {
              yield* Effect.sleep(remainingDelay);
            }

            yield* Queue.poll(dashboardInvalidations);
          }

          const snapshot = yield* readDashboardSnapshot;
          const { dashboard } = snapshot;
          yield* reconcileDashboardRuns(dashboard.activeRuns);
          const lastProjectionAt = yield* Clock.currentTimeMillis;
          dashboardProjectionSequence += 1;
          const projections: readonly DashboardProjectionEnvelope[] = [
            {
              ...snapshot,
              projectionSequence: dashboardProjectionSequence,
            },
          ];

          return [
            projections,
            Option.some<DashboardProjectionState>({
              isInitialProjection: false,
              lastProjectionAt,
            }),
          ] as const;
        })
      );
    })
  );
  const migrationServerService = (
    observeDashboard: MigrateServerService["observeDashboard"],
    observeDashboardLease: MigrateServerService["observeDashboardLease"]
  ): MigrateServerService => ({
    breakLock: ({ lock }) =>
      backend
        .breakLock(lock)
        .pipe(Effect.tap(invalidateDashboard), Effect.mapError(operationError)),
    getDashboard,
    getActiveRuns,
    getMessages: ({ target }) =>
      backend.getMessages(target).pipe(Effect.mapError(operationError)),
    getServerInfo: Effect.succeed(serverInfo),
    getSourceIdentityHistory: ({ definitionId }) =>
      backend
        .getSourceIdentityHistory(definitionId)
        .pipe(Effect.mapError(operationError)),
    getSourceItemTotals: ({ definitionIds }) =>
      backend
        .getSourceItemTotals(definitionIds)
        .pipe(Effect.mapError(operationError)),
    normalizeSourceIdentity: ({ definitionId, sourceIdentity }) =>
      backend
        .normalizeSourceIdentity(definitionId, sourceIdentity)
        .pipe(Effect.mapError(operationError)),
    observeDashboard,
    observeDashboardLease,
    observeRun,
    observeRunLease,
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
          MigrateRunStartResult,
          MigrateProtocolError
        >();
        const record: ExecutionRecord = {
          closed: false,
          executionId,
          events: [],
          listeners: new Set(),
          observationDefinitionId:
            currentPreparedOperation.operation.observationDefinitionId,
        };
        let reference: MigrateRunStartResult | undefined;
        let runId: MigrationRunId | undefined;

        const resolveStart = (nextReference: MigrateRunStartResult) => {
          if (reference === undefined) {
            reference = nextReference;
            Deferred.doneUnsafe(started, Effect.succeed(nextReference));
          }
        };

        const backendExecution = yield* backend
          .executeOperation(currentPreparedOperation.executable, {
            onDashboardInvalidation: invalidateDashboardUnsafe,
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
                registerRun(record, state.runId, state.ownership);
                resolveStart({
                  runId: state.runId,
                  status: "started",
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
              resolveStart({
                runId: result.runId,
                status: "completed",
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
          Effect.ensuring(Effect.sync(() => removeExecution(record)))
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
          record.ownership === "server" &&
          record.stop !== undefined
        ) {
          const cancellation = yield* record.stop;

          if (cancellation.kind === "requested") {
            return { ...cancellation, runId };
          }
          if (cancellation.kind === "provider-owned") {
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

        if (backend.stopRun !== undefined) {
          const cancellation = yield* backend.stopRun(runId);

          if (cancellation.kind === "requested") {
            publishProviderCancellation(record, runId);
            return { ...cancellation, runId };
          }
          if (cancellation.kind === "provider-owned") {
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
      }).pipe(Effect.tap(invalidateDashboard), Effect.mapError(operationError)),
  });

  return dashboardProjectionSource.pipe(
    Stream.share({ capacity: 1, replay: 1, strategy: "sliding" }),
    Effect.map((dashboardProjections) => {
      const observeDashboard: MigrateServerService["observeDashboard"] = ({
        after,
      }) =>
        Stream.unwrap(
          Effect.sync(() => {
            const afterProjectionSequence = dashboardProjectionSequence;
            invalidateDashboardUnsafe();

            return dashboardProjections.pipe(
              Stream.filter(
                (projection) =>
                  projection.projectionSequence > afterProjectionSequence
              ),
              Stream.map(({ dashboard, resumeToken }) => ({
                dashboard,
                resumeToken,
              })),
              Stream.mapAccum(
                () => after,
                (previousResumeToken, snapshot) =>
                  [
                    snapshot.resumeToken,
                    previousResumeToken === snapshot.resumeToken
                      ? []
                      : [snapshot],
                  ] as const
              )
            );
          })
        );

      return migrationServerService(observeDashboard, ({ after }) =>
        observeDashboard({ after }).pipe(
          Stream.interruptWhen(Effect.sleep(observationLeaseDuration)),
          Stream.runHead,
          Effect.map(
            Option.match({
              onNone: () => ({ kind: "heartbeat" as const }),
              onSome: (snapshot) => ({
                kind: "snapshot" as const,
                snapshot,
              }),
            })
          )
        )
      );
    })
  );
};

const makeMigrationServerService = <ExecutableOperation>(
  input: MigrateServerInput<ExecutableOperation>,
  runExecution: (effect: Effect.Effect<void>) => unknown
): Effect.Effect<MigrateServerService, never, Scope> =>
  Effect.gen(function* () {
    const dashboardInvalidations = yield* Queue.sliding<void>(1);
    const dashboardReadSemaphore = yield* Semaphore.make(1);

    return yield* makeMigrationServerServiceWithInvalidationQueue(
      input,
      runExecution,
      dashboardInvalidations,
      dashboardReadSemaphore
    );
  });

export class MigrateServer extends Context.Service<
  MigrateServer,
  MigrateServerService
>()("@migrate-sdk/server/MigrateServer") {
  static readonly make = <ExecutableOperation>(
    input: MigrateServerInput<ExecutableOperation>
  ): Effect.Effect<MigrateServerService, never, Scope> =>
    Effect.gen(function* () {
      const runExecution = yield* FiberSet.makeRuntime<never, void, never>();
      return yield* makeMigrationServerService(input, runExecution);
    });

  static readonly layer = <ExecutableOperation>(
    input: MigrateServerInput<ExecutableOperation>
  ): Layer.Layer<MigrateServer> =>
    Layer.effect(MigrateServer, MigrateServer.make(input));
}
