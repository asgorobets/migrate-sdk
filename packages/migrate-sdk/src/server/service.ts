import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  FiberMap,
  FiberSet,
  Layer,
  Queue,
  Schedule,
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
import type { MigrationExecutionUpdate } from "../domain/item-progress.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type { MigrationMessage } from "../domain/message.ts";
import type {
  MigrationDefinitionMetadata,
  MigrationDefinitionStatus,
} from "../domain/status.ts";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateActiveRun,
  type MigrateBreakLockResult,
  MigrateDashboard,
  type MigrateDashboardFrame,
  type MigrateDashboardResume,
  MigrateDashboardResumeToken,
  type MigrateDashboardSnapshot,
  type MigrateDefinitionIds,
  type MigrateDefinitionSourceItemTotal,
  type MigrateEnvironmentInfo,
  type MigrateExecutionState,
  type MigrateObservationContinuingEvent,
  MigrateObservationEvent,
  type MigrateObservationFrame,
  MigrateObservationResumeToken,
  MigrateOperationError,
  type MigrateOperationRequest,
  MigratePlanChangedError,
  MigratePlanFingerprint,
  type MigratePreparedOperation,
  MigrateProtocolError,
  type MigrateRegistry,
  type MigrateRegistryMessagesReport,
  type MigrateRegistryMessagesRequest,
  type MigrateRegistryStatusReport,
  type MigrateRegistryStatusRequest,
  type MigrateRunStartResult,
  type MigrateRunStopResult,
  type MigrateServerInfo,
  type MigrateServerInstanceId,
  type MigrateSourceIdentityHistoryEntry,
  type MigrateStoreSchema,
  type MigrateStoreSchemaPlan,
  type MigrateTarget,
  type MigrateTerminalSummary,
} from "../protocol/index.ts";
import type { MigrationExecutableObservationOptions } from "../services/migration-executable.ts";
import type { SqlMigrationStoreSchemaConfig } from "../stores/sql/sql-migration-store-schema-plan.ts";
import { MIGRATE_SDK_VERSION } from "../version.ts";
import { makeStoreSchemaOperations } from "./store-schema.ts";

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
  readonly getRegistry: Effect.Effect<MigrateRegistry, MigrateProtocolError>;
  readonly getRegistryMessages: (
    input: MigrateRegistryMessagesRequest
  ) => Effect.Effect<MigrateRegistryMessagesReport, MigrateProtocolError>;
  readonly getRegistryStatus: (
    input: MigrateRegistryStatusRequest
  ) => Effect.Effect<MigrateRegistryStatusReport, MigrateProtocolError>;
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
  readonly getStoreSchema: Effect.Effect<
    MigrateStoreSchema,
    MigrateProtocolError
  >;
  readonly normalizeSourceIdentity: (input: {
    readonly definitionId: MigrationDefinitionId;
    readonly sourceIdentity: string;
  }) => Effect.Effect<string, MigrateProtocolError>;
  readonly observeDashboard: (input: {
    readonly after?: MigrateDashboardResumeToken | undefined;
    readonly resume?: MigrateDashboardResume;
  }) => Stream.Stream<MigrateDashboardSnapshot, MigrateProtocolError>;
  readonly observeDashboardSession: (input: {
    readonly after?: MigrateDashboardResumeToken | undefined;
    readonly resume?: MigrateDashboardResume;
  }) => Stream.Stream<MigrateDashboardFrame, MigrateProtocolError>;
  readonly observeRun: (input: {
    readonly runId: MigrationRunId;
  }) => Stream.Stream<MigrateObservationEvent, MigrateProtocolError>;
  readonly observeRunSession: (input: {
    readonly after?: MigrateObservationResumeToken | undefined;
    readonly progressAfter?: string;
    readonly runId: MigrationRunId;
  }) => Stream.Stream<MigrateObservationFrame, MigrateProtocolError>;
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
  readonly upgradeStoreSchema: (input: {
    readonly acceptedPlanId: string;
  }) => Effect.Effect<MigrateStoreSchemaPlan, MigrateProtocolError>;
}

export interface MigrateServerExecutionObserver {
  readonly after?: string;
  readonly onDashboardInvalidation: () => void;
  readonly onExecutionProgress?: (update: MigrationExecutionUpdate) => void;
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
  readonly summary?: MigrateTerminalSummary;
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
  readonly getDefinitionMetadata?: (
    definitionIds: readonly MigrationDefinitionId[]
  ) => Effect.Effect<readonly MigrationDefinitionMetadata[], unknown>;
  readonly getMessages: (
    target: MigrateTarget
  ) => Effect.Effect<readonly MigrationMessage[], unknown>;
  readonly getRegistry: Effect.Effect<MigrateRegistry, unknown>;
  readonly getRegistryMessages: (
    input: MigrateRegistryMessagesRequest
  ) => Effect.Effect<MigrateRegistryMessagesReport, unknown>;
  readonly getRegistryStatus: (
    input: MigrateRegistryStatusRequest
  ) => Effect.Effect<MigrateRegistryStatusReport, unknown>;
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
        options: MigrationExecutableObservationOptions
      ) => Effect.Effect<void, unknown>)
    | undefined;
}

export interface MigrateServerInput<ExecutableOperation> {
  readonly backend: MigrateServerBackend<ExecutableOperation>;
  readonly dashboardFallbackInterval?: Duration.Input | undefined;
  readonly dashboardProjectionInterval?: Duration.Input | undefined;
  readonly environment: MigrateEnvironmentInfo;
  readonly instanceId?: MigrateServerInstanceId | undefined;
  readonly observationSessionDuration?: Duration.Input | undefined;
  readonly registryId?: MigrationDefinitionRegistryId | undefined;
  readonly sqlStore?: SqlMigrationStoreSchemaConfig | undefined;
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
  selection: operation.selection,
  sourceIdentities: operation.sourceIdentities,
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

const makeMigrationServerObservationService = <ExecutableOperation>(
  {
    backend,
    sqlStore,
    dashboardFallbackInterval = "30 seconds",
    dashboardProjectionInterval = "1 second",
    environment,
    instanceId,
    observationSessionDuration = "4 minutes",
    registryId,
  }: MigrateServerInput<ExecutableOperation>,
  runExecution: (effect: Effect.Effect<void>) => unknown,
  dashboardReadSemaphore: Semaphore.Semaphore
): Effect.Effect<MigrateServerService, never, Scope> => {
  const storeSchema = makeStoreSchemaOperations(sqlStore);
  const serverInfo: MigrateServerInfo = {
    environment,
    ...(instanceId === undefined ? {} : { instanceId }),
    protocolVersion: MIGRATE_PROTOCOL_VERSION,
    ...(registryId === undefined ? {} : { registryId }),
    sdkVersion: MIGRATE_SDK_VERSION,
  };
  const executionsByRunId = new Map<string, ExecutionRecord>();
  const dashboardListeners = new Set<
    (definitionIds: readonly MigrationDefinitionId[]) => void
  >();
  const invalidateDashboardUnsafe = (
    definitionIds: readonly MigrationDefinitionId[] = []
  ) => {
    for (const listener of dashboardListeners) {
      listener(definitionIds);
    }
  };
  const invalidateDashboard = Effect.sync(() => invalidateDashboardUnsafe());

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

    if (event.kind !== "warning" && event.kind !== "execution-progress") {
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
    observationDefinitionId?: MigrationDefinitionId,
    progressAfter?: string
  ): Stream.Stream<MigrateObservationEvent, MigrateProtocolError> =>
    Stream.callback<MigrateObservationEvent, MigrateProtocolError>((queue) =>
      backend
        .observeRun(
          runId,
          {
            ...(progressAfter === undefined ? {} : { after: progressAfter }),
            onExecutionProgress: (update) =>
              Queue.offerUnsafe(queue, { kind: "execution-progress", update }),
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
                      ...(result.summary === undefined
                        ? {}
                        : { summary: result.summary }),
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

    return record.ownership === "provider" && position === undefined
      ? 0
      : record.events.length;
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

  const continuingFrame = (
    events: readonly [
      ContinuingObservationEnvelope,
      ...ContinuingObservationEnvelope[],
    ]
  ): MigrateObservationFrame => {
    const nextResumeToken = events.at(-1)?.resumeToken ?? events[0].resumeToken;

    return {
      events,
      kind: "continuing",
      nextResumeToken,
    };
  };

  const terminalFrame = (
    completion: CompletionObservationEnvelope,
    events: readonly ContinuingObservationEnvelope[] = []
  ): Extract<MigrateObservationFrame, { kind: "terminal" }> => ({
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
    next.event.kind === "execution-progress" ||
    next.event.kind === "progress" ||
    next.event.kind === "state" ||
    next.event.kind === "warning";

  const isCompletionEnvelope = (
    next: ObservationEnvelope
  ): next is CompletionObservationEnvelope =>
    next.event.kind === "detached" || next.event.kind === "terminal";

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

  const reconcileTerminalObservationFrame = (
    runId: MigrationRunId,
    observationDefinitionId: MigrationDefinitionId | undefined,
    owned: ExecutionRecord | undefined,
    ownedPosition: ExecutionObservationResumePosition | undefined,
    seenEventToken: MigrateObservationResumeToken | undefined,
    observedFrame: Extract<MigrateObservationFrame, { kind: "terminal" }>
  ): Effect.Effect<MigrateObservationFrame, MigrateProtocolError> =>
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
        observedFrame.event.event.kind === "terminal"
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
        return observedFrame;
      }

      return terminalFrame(observedFrame.event, [
        ...observedFrame.events,
        finalEnvelope,
      ]);
    });

  const observationSession = <A>(
    updates: Stream.Stream<A, MigrateProtocolError>
  ): Stream.Stream<A | { readonly kind: "heartbeat" }, MigrateProtocolError> =>
    Stream.succeed({ kind: "heartbeat" as const }).pipe(
      Stream.concat(
        updates.pipe(
          Stream.merge(
            Stream.tick("15 seconds").pipe(
              Stream.drop(1),
              Stream.map(() => ({ kind: "heartbeat" as const }))
            ),
            { haltStrategy: "left" }
          )
        )
      ),
      Stream.interruptWhen(Effect.sleep(observationSessionDuration))
    );

  const observeRunSession: MigrateServerService["observeRunSession"] = ({
    after,
    progressAfter,
    runId,
  }) =>
    observationSession(
      Stream.unwrap(
        Effect.gen(function* () {
          const {
            owned,
            ownedPosition,
            requestedObservationDefinitionId,
            seenEventToken,
          } = observationResumePosition(runId, after);
          // Capture the owned event position before reading the snapshot so
          // events produced during that read remain available for replay.
          const startIndex =
            owned === undefined
              ? 0
              : ownedObservationStartIndex(owned, ownedPosition);
          const initial =
            progressAfter === undefined
              ? yield* initialRunProgress(
                  runId,
                  requestedObservationDefinitionId
                )
              : undefined;
          const observationDefinitionId =
            initial?.observationDefinitionId ??
            requestedObservationDefinitionId;
          const initialEnvelope = yield* initialProgressEnvelope(
            initial,
            owned,
            ownedPosition
          );
          let lastEventToken = seenEventToken;
          const initialFrames: MigrateObservationFrame[] = [];
          if (
            initialEnvelope !== undefined &&
            resumeEventToken(initialEnvelope.resumeToken) !== lastEventToken
          ) {
            initialFrames.push(continuingFrame([initialEnvelope]));
            lastEventToken = resumeEventToken(initialEnvelope.resumeToken);
          }

          const events =
            owned === undefined
              ? observeBackendRun(
                  runId,
                  observationDefinitionId,
                  progressAfter
                ).pipe(
                  Stream.mapEffect((event) =>
                    observationDefinitionId === undefined
                      ? envelope(event)
                      : backendEnvelope(observationDefinitionId, event)
                  )
                )
              : observeRecordEntriesFromIndex(owned, startIndex).pipe(
                  Stream.mapEffect((entry) => ownedEnvelope(owned, entry))
                );

          return Stream.fromIterable(initialFrames).pipe(
            Stream.concat(
              events.pipe(
                Stream.mapEffect((next) =>
                  Effect.gen(function* () {
                    if (isContinuingEnvelope(next)) {
                      if (next.event.kind === "progress") {
                        const eventToken = resumeEventToken(next.resumeToken);
                        // Compare with the last delivered progress, so A -> B -> A
                        // remains observable even when warnings occur between updates.
                        if (eventToken === lastEventToken) {
                          return;
                        }
                        lastEventToken = eventToken;
                      }
                      // Lifecycle and warnings must not wait for another checkpoint:
                      // a quiet session might expire before one arrives.
                      return continuingFrame([next]);
                    }
                    if (!isCompletionEnvelope(next)) {
                      return;
                    }
                    return yield* reconcileTerminalObservationFrame(
                      runId,
                      observationDefinitionId,
                      owned,
                      ownedPosition,
                      lastEventToken,
                      terminalFrame(next)
                    );
                  })
                ),
                Stream.filter((frame) => frame !== undefined),
                Stream.takeUntil((frame) => frame.kind === "terminal")
              )
            )
          );
        })
      )
    );

  const observeDashboard: MigrateServerService["observeDashboard"] = ({
    resume,
  }) =>
    Stream.callback<MigrateDashboardSnapshot, MigrateProtocolError>((queue) =>
      Effect.gen(function* () {
        const watchers = yield* FiberMap.make<MigrationRunId, void, never>();
        const wake = yield* Queue.sliding<void>(1);
        const dirtyDefinitions = new Set<MigrationDefinitionId>();
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (ids: readonly MigrationDefinitionId[]) => {
              for (const id of ids) {
                dirtyDefinitions.add(id);
              }
              Queue.offerUnsafe(wake, undefined);
            };
            dashboardListeners.add(listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              dashboardListeners.delete(listener);
            })
        );
        const known = new Map((resume ?? []).map((run) => [run.runId, run]));
        const finished = new Set<MigrationRunId>();
        const readMetadata = (ids: readonly MigrationDefinitionId[]) =>
          (ids.length === 0
            ? Effect.succeed([])
            : (backend.getDefinitionMetadata?.(ids) ?? Effect.succeed([]))
          ).pipe(
            Effect.catch(() => {
              for (const id of ids) {
                dirtyDefinitions.add(id);
              }
              return Effect.succeed([]);
            })
          );
        const readDirtyMetadata = Effect.suspend(() => {
          const ids = [...dirtyDefinitions];
          dirtyDefinitions.clear();
          return readMetadata(ids);
        });
        let dashboard: MigrateDashboard;
        let initial = true;
        const emission = yield* Semaphore.make(1);
        const emit = (
          progress?: MigrationExecutionUpdate,
          definitions: readonly MigrationDefinitionStatus[] = [],
          metadata: readonly MigrationDefinitionMetadata[] = [],
          activeRuns?: readonly MigrateActiveRun[]
        ) =>
          Effect.gen(function* () {
            if (activeRuns !== undefined) {
              dashboard = { ...dashboard, activeRuns };
            }
            if (
              progress !== undefined &&
              !dashboard.activeRuns.some((run) => run.runId === progress.runId)
            ) {
              return;
            }
            const statuses = new Map(
              definitions.map((status) => [status.definitionId, status])
            );
            const partial = {
              ...dashboard,
              rows: dashboard.rows.map(({ entry }) => ({
                entry,
                ...(statuses.has(entry.id)
                  ? { status: statuses.get(entry.id) }
                  : {}),
              })),
            };
            const resumeToken =
              progress === undefined
                ? yield* dashboardResumeToken(partial)
                : yield* observationResumeToken({
                    kind: "execution-progress",
                    update: progress,
                  });
            Queue.offerUnsafe(queue, {
              dashboard: partial,
              partial: true,
              metadata,
              resumeToken: MigrateDashboardResumeToken.make(resumeToken),
              ...(progress === undefined ? {} : { progress }),
            });
          }).pipe(emission.withPermit);
        if (resume === undefined) {
          const snapshot = yield* readDashboardSnapshot;
          dashboard = snapshot.dashboard;
          Queue.offerUnsafe(queue, snapshot);
        } else {
          const registry = yield* backend.getRegistry.pipe(
            Effect.mapError(operationError)
          );
          dashboard = {
            groups: registry.groups,
            scannedSource: false,
            activeRuns: yield* getActiveRuns,
            rows: registry.entries.map((entry) => ({ entry })),
          };
          for (const run of dashboard.activeRuns) {
            for (const id of run.definitionIds) {
              dirtyDefinitions.add(id);
            }
          }
        }
        const relayExecutionUpdate = (
          runId: MigrationRunId,
          event: MigrationExecutionUpdate
        ) =>
          Effect.gen(function* () {
            if (
              event.runId !== runId ||
              !dashboard.activeRuns.some((run) => run.runId === runId)
            ) {
              return;
            }
            if (event.kind === "state-changed") {
              for (const id of event.definitionIds) {
                dirtyDefinitions.add(id);
              }
            }
            const metadata =
              event.replaying === true ? [] : yield* readDirtyMetadata;
            yield* emit(event, [], metadata);
            const position = known.get(runId);
            if (position !== undefined && event.cursor !== undefined) {
              known.set(runId, { ...position, cursor: event.cursor });
            }
          });
        const watchRun = (run: MigrateActiveRun) =>
          Effect.gen(function* () {
            // Provider termination can precede the durable lifecycle transition.
            // Keep its slot until the store agrees, without reattaching or rescanning.
            if (finished.has(run.runId)) {
              return;
            }
            const position = known.get(run.runId);
            known.set(run.runId, {
              runId: run.runId,
              observationDefinitionId: run.observationDefinitionId,
              ...(position?.cursor === undefined
                ? {}
                : { cursor: position.cursor }),
            });
            const owned = executionsByRunId.get(run.runId);
            const observe =
              owned?.ownership === "server"
                ? observeRecord(owned).pipe(
                    Stream.runForEach((event) =>
                      event.kind === "progress"
                        ? emit(undefined, event.definitions)
                        : Effect.void
                    )
                  )
                : Effect.suspend(() => {
                    const after = known.get(run.runId)?.cursor;
                    return (
                      backend.watchDashboardRun?.(run, {
                        ...(after === undefined ? {} : { after }),
                        onEvent: (event) =>
                          relayExecutionUpdate(run.runId, event),
                      }) ?? Effect.never
                    );
                  }).pipe(
                    Effect.retry(
                      Schedule.exponential("1 second").pipe(
                        Schedule.modifyDelay(({ duration }) =>
                          Effect.succeed(
                            Math.min(Duration.toMillis(duration), 30_000)
                          )
                        ),
                        Schedule.jittered
                      )
                    )
                  );
            yield* FiberMap.run(
              watchers,
              run.runId,
              observe.pipe(
                Effect.catch((cause) =>
                  Effect.sync(() =>
                    Queue.failCauseUnsafe(
                      queue,
                      Cause.fail(operationError(cause))
                    )
                  )
                ),
                Effect.andThen(
                  Effect.sync(() => {
                    finished.add(run.runId);
                    Queue.offerUnsafe(wake, undefined);
                  })
                )
              ),
              { onlyIfMissing: true, startImmediately: true }
            );
          });
        const reconcile = (activeRuns: readonly MigrateActiveRun[]) =>
          Effect.gen(function* () {
            const activeIds = new Set(activeRuns.map((run) => run.runId));
            const definitions: MigrationDefinitionStatus[] = [];
            const metadata = yield* readDirtyMetadata;
            for (const [runId, position] of known) {
              if (activeIds.has(runId)) {
                continue;
              }
              const progress = yield* backend
                .getRunProgress(runId, position.observationDefinitionId)
                .pipe(Effect.mapError(operationError));
              definitions.push(...(progress?.definitions ?? []));
              known.delete(runId);
              finished.delete(runId);
              yield* FiberMap.remove(watchers, runId);
            }
            if (!initial || resume !== undefined || definitions.length > 0) {
              // Publish run removal together with final totals. Until then, other
              // frames must retain its locator so a replacement server can finish.
              yield* emit(undefined, definitions, metadata, activeRuns);
            }
            initial = false;
            yield* Effect.forEach(dashboard.activeRuns, watchRun, {
              discard: true,
            });
          });
        yield* reconcile(dashboard.activeRuns);
        while (true) {
          // This only discovers run lifecycle changes. It never scans item states.
          yield* Effect.raceFirst(
            Queue.take(wake),
            Effect.sleep(dashboardFallbackInterval)
          );
          yield* Effect.sleep(dashboardProjectionInterval);
          const activeRuns = yield* getActiveRuns;
          for (const run of activeRuns) {
            const previous = dashboard.activeRuns.find(
              (candidate) => candidate.runId === run.runId
            );
            if (previous?.status !== run.status) {
              for (const id of run.definitionIds) {
                dirtyDefinitions.add(id);
              }
            }
          }
          yield* reconcile(activeRuns);
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => Queue.failCauseUnsafe(queue, Cause.fail(error)))
        ),
        Effect.forkScoped
      )
    );
  const migrationServerService = (
    observeDashboard: MigrateServerService["observeDashboard"]
  ): MigrateServerService => ({
    breakLock: ({ lock }) =>
      backend.breakLock(lock).pipe(
        Effect.tap(() =>
          Effect.sync(() => invalidateDashboardUnsafe([lock.definitionId]))
        ),
        Effect.mapError(operationError)
      ),
    getDashboard,
    getActiveRuns,
    getMessages: ({ target }) =>
      backend.getMessages(target).pipe(Effect.mapError(operationError)),
    getRegistry: backend.getRegistry.pipe(Effect.mapError(operationError)),
    getRegistryMessages: (input) =>
      backend.getRegistryMessages(input).pipe(Effect.mapError(operationError)),
    getRegistryStatus: (input) =>
      backend.getRegistryStatus(input).pipe(Effect.mapError(operationError)),
    getServerInfo: Effect.succeed(serverInfo),
    getStoreSchema: storeSchema.getSchema.pipe(Effect.mapError(operationError)),
    upgradeStoreSchema: ({ acceptedPlanId }) =>
      storeSchema
        .upgradeSchema(acceptedPlanId)
        .pipe(Effect.tap(invalidateDashboard), Effect.mapError(operationError)),
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
    observeDashboardSession: (input) =>
      observationSession(
        observeDashboard(input).pipe(
          Stream.map((snapshot) => ({ kind: "snapshot" as const, snapshot }))
        )
      ),
    observeRun,
    observeRunSession,
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
            onExecutionProgress: (update) =>
              publish(record, { kind: "execution-progress", update }),
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
                      ...(result.summary === undefined
                        ? {}
                        : { summary: result.summary }),
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

  return Effect.succeed(migrationServerService(observeDashboard));
};

const makeMigrationServerService = <ExecutableOperation>(
  input: MigrateServerInput<ExecutableOperation>,
  runExecution: (effect: Effect.Effect<void>) => unknown
): Effect.Effect<MigrateServerService, never, Scope> =>
  Effect.gen(function* () {
    const dashboardReadSemaphore = yield* Semaphore.make(1);

    return yield* makeMigrationServerObservationService(
      input,
      runExecution,
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
