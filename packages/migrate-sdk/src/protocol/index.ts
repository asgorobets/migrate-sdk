import { Schema } from "effect";
import { make as makeRpc } from "effect/unstable/rpc/Rpc";
import { make as makeRpcGroup } from "effect/unstable/rpc/RpcGroup";
import {
  MigrationDefinitionGroupId,
  MigrationDefinitionId,
  MigrationDefinitionRegistryId,
  MigrationRunId,
} from "../domain/ids.ts";
import { MigrationDefinitionLock } from "../domain/lock.ts";
import { MigrationMessage } from "../domain/message.ts";
import { activeMigrationRunHasObservationDefinition } from "../domain/run.ts";
import { MigrationDefinitionStatus } from "../domain/status.ts";

export const MIGRATE_PROTOCOL_VERSION = 1;

const PositiveInteger = Schema.Finite.check(Schema.isInt()).check(
  Schema.isGreaterThan(0)
);

export const MigrateProtocolVersion = PositiveInteger;
export type MigrateProtocolVersion = typeof MigrateProtocolVersion.Type;

export const MigrateEnvironmentInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.optional(Schema.NonEmptyString),
});
export type MigrateEnvironmentInfo = typeof MigrateEnvironmentInfo.Type;

export const MigrateServerInfo = Schema.Struct({
  environment: MigrateEnvironmentInfo,
  protocolVersion: MigrateProtocolVersion,
  registryId: Schema.optional(MigrationDefinitionRegistryId),
  sdkVersion: Schema.String,
});
export type MigrateServerInfo = typeof MigrateServerInfo.Type;

export const MigrateAction = Schema.Literals([
  "rescan",
  "retry-failed",
  "retry-skipped",
  "rollback",
  "run",
  "update",
]);
export type MigrateAction = typeof MigrateAction.Type;

export const MigrateActiveRun = Schema.Struct({
  definitionIds: Schema.NonEmptyArray(MigrationDefinitionId),
  execution: Schema.optional(
    Schema.Struct({
      adapter: Schema.NonEmptyString,
      executionId: Schema.NonEmptyString,
    })
  ),
  observationDefinitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  startedAt: Schema.DateFromString,
  status: Schema.Literals(["queued", "running"]),
  stopSupported: Schema.Boolean,
}).check(
  Schema.makeFilter(activeMigrationRunHasObservationDefinition, {
    message: "Observation definition must belong to the Active Migration Run",
  })
);
export type MigrateActiveRun = typeof MigrateActiveRun.Type;

export const MigrateTarget = Schema.Union([
  Schema.Struct({
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("migration"),
  }),
  Schema.Struct({
    groupId: MigrationDefinitionGroupId,
    kind: Schema.Literal("group"),
  }),
]);
export type MigrateTarget = typeof MigrateTarget.Type;

export const MigratePipelineConcurrency = Schema.Union([
  PositiveInteger,
  Schema.Literal("unbounded"),
]);
export type MigratePipelineConcurrency = typeof MigratePipelineConcurrency.Type;

export const MigrateExecutionOptions = Schema.Struct({
  process: Schema.optional(
    Schema.Struct({ concurrency: Schema.optional(MigratePipelineConcurrency) })
  ),
  rollback: Schema.optional(
    Schema.Struct({ concurrency: Schema.optional(MigratePipelineConcurrency) })
  ),
});
export type MigrateExecutionOptions = typeof MigrateExecutionOptions.Type;

export const MigratePrepareOptions = Schema.Struct({
  execution: Schema.optional(MigrateExecutionOptions),
  force: Schema.optional(Schema.Boolean),
  sourceIdentities: Schema.optional(Schema.Array(Schema.String)),
  withDependencies: Schema.optional(Schema.Boolean),
});
export type MigratePrepareOptions = typeof MigratePrepareOptions.Type;

export const MigrateOperationRequest = Schema.Struct({
  action: MigrateAction,
  options: MigratePrepareOptions,
  target: MigrateTarget,
});
export type MigrateOperationRequest = typeof MigrateOperationRequest.Type;

export const MigrateRegistryEntry = Schema.Struct({
  dependencies: Schema.Struct({
    optional: Schema.Array(MigrationDefinitionId),
    required: Schema.Array(MigrationDefinitionId),
  }),
  group: Schema.optional(MigrationDefinitionGroupId),
  hasRollback: Schema.Boolean,
  id: MigrationDefinitionId,
});
export type MigrateRegistryEntry = typeof MigrateRegistryEntry.Type;

export const MigrateRegistryGroup = Schema.Struct({
  definitionIds: Schema.Array(MigrationDefinitionId),
  id: MigrationDefinitionGroupId,
});
export type MigrateRegistryGroup = typeof MigrateRegistryGroup.Type;

export const MigrateDashboardRow = Schema.Struct({
  entry: MigrateRegistryEntry,
  status: Schema.optional(MigrationDefinitionStatus),
});
export type MigrateDashboardRow = typeof MigrateDashboardRow.Type;

export const MigrateDashboard = Schema.Struct({
  activeRuns: Schema.Array(MigrateActiveRun),
  groups: Schema.Array(MigrateRegistryGroup),
  rows: Schema.Array(MigrateDashboardRow),
  scannedSource: Schema.Boolean,
});
export type MigrateDashboard = typeof MigrateDashboard.Type;

export const MigrateDashboardResumeToken = Schema.NonEmptyString.pipe(
  Schema.brand("MigrateDashboardResumeToken")
);
export type MigrateDashboardResumeToken =
  typeof MigrateDashboardResumeToken.Type;

export const MigrateDashboardSnapshot = Schema.Struct({
  dashboard: MigrateDashboard,
  resumeToken: MigrateDashboardResumeToken,
});
export type MigrateDashboardSnapshot = typeof MigrateDashboardSnapshot.Type;

export const MigrateDashboardLease = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("heartbeat"),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: MigrateDashboardSnapshot,
  }),
]);
export type MigrateDashboardLease = typeof MigrateDashboardLease.Type;

export const MigrateDependencyCheck = Schema.Struct({
  dependencyId: MigrationDefinitionId,
  requiredByDefinitionId: MigrationDefinitionId,
  row: Schema.optional(MigrateDashboardRow),
  satisfied: Schema.Boolean,
});
export type MigrateDependencyCheck = typeof MigrateDependencyCheck.Type;

export const MigratePlanFingerprint = Schema.NonEmptyString.pipe(
  Schema.brand("MigratePlanFingerprint")
);
export type MigratePlanFingerprint = typeof MigratePlanFingerprint.Type;

export const MigratePlanProjection = Schema.Struct({
  execution: Schema.optional(MigrateExecutionOptions),
  executionDefinitionIds: Schema.Array(MigrationDefinitionId),
  force: Schema.optional(Schema.Boolean),
  requestedDefinitionIds: Schema.Union([
    Schema.Literal("all"),
    Schema.Array(MigrationDefinitionId),
  ]),
  withDependencies: Schema.Boolean,
});
export type MigratePlanProjection = typeof MigratePlanProjection.Type;

export const MigratePreparedOperation = Schema.Struct({
  action: MigrateAction,
  dependencyChecks: Schema.Array(MigrateDependencyCheck),
  fingerprint: MigratePlanFingerprint,
  observationDefinitionId: MigrationDefinitionId,
  plan: MigratePlanProjection,
  planRows: Schema.Array(MigrateDashboardRow),
  request: MigrateOperationRequest,
  sourceIdentities: Schema.optional(Schema.Array(Schema.String)),
  target: MigrateTarget,
});
export type MigratePreparedOperation = typeof MigratePreparedOperation.Type;

export const MigrateSourceIdentityHistoryEntry = Schema.Struct({
  sourceIdentity: Schema.String,
  status: Schema.Literals(["failed", "migrated", "needs-update", "skipped"]),
  updatedAt: Schema.DateFromString,
});
export type MigrateSourceIdentityHistoryEntry =
  typeof MigrateSourceIdentityHistoryEntry.Type;

const MigrateSourceItemTotalCount = Schema.Finite.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0)
);

export const MigrateSourceItemTotal = Schema.Union([
  Schema.Struct({
    count: MigrateSourceItemTotalCount,
    kind: Schema.Literal("known"),
  }),
  Schema.Struct({
    kind: Schema.Literal("lower-bound"),
    minimum: MigrateSourceItemTotalCount,
    reason: Schema.Literal("capped"),
  }),
  Schema.Struct({
    kind: Schema.Literal("unknown"),
    reason: Schema.Literals([
      "disabled",
      "failed",
      "too-expensive",
      "unsupported",
    ]),
  }),
]);
export type MigrateSourceItemTotal = typeof MigrateSourceItemTotal.Type;

export const MigrateDefinitionSourceItemTotal = Schema.Struct({
  definitionId: MigrationDefinitionId,
  total: MigrateSourceItemTotal,
});
export type MigrateDefinitionSourceItemTotal =
  typeof MigrateDefinitionSourceItemTotal.Type;

export const MigrateDefinitionIds = Schema.NonEmptyArray(MigrationDefinitionId);
export type MigrateDefinitionIds = typeof MigrateDefinitionIds.Type;

export const MigrateExecutionState = Schema.Union([
  Schema.Struct({
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("starting"),
  }),
  Schema.Struct({
    adapter: Schema.String,
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("running"),
    ownership: Schema.Literal("server"),
    runId: MigrationRunId,
  }),
  Schema.Struct({
    adapter: Schema.String,
    definitionId: MigrationDefinitionId,
    executionId: Schema.String,
    kind: Schema.Literal("running"),
    ownership: Schema.Literal("provider"),
    runId: MigrationRunId,
  }),
  Schema.Struct({
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("cancelling"),
    runId: Schema.optional(MigrationRunId),
  }),
]);
export type MigrateExecutionState = typeof MigrateExecutionState.Type;

export const MigrateRunStartResult = Schema.Struct({
  runId: MigrationRunId,
  status: Schema.Literals(["completed", "started"]),
});
export type MigrateRunStartResult = typeof MigrateRunStartResult.Type;

export const MigrateObservationResumeToken = Schema.NonEmptyString.pipe(
  Schema.brand("MigrateObservationResumeToken")
);
export type MigrateObservationResumeToken =
  typeof MigrateObservationResumeToken.Type;

const MigrateDetachedObservationEvent = Schema.Struct({
  kind: Schema.Literal("detached"),
  message: Schema.String,
  runId: MigrationRunId,
});

const MigrateTerminalObservationEvent = Schema.Struct({
  kind: Schema.Literal("terminal"),
  message: Schema.String,
  outcome: Schema.Literals(["cancelled", "completed", "failed"]),
  runId: MigrationRunId,
});

const MigrateStateObservationEvent = Schema.Struct({
  kind: Schema.Literal("state"),
  state: MigrateExecutionState,
});

const MigrateProgressObservationEvent = Schema.Struct({
  definitions: Schema.Array(MigrationDefinitionStatus),
  kind: Schema.Literal("progress"),
});

const MigrateWarningObservationEvent = Schema.Struct({
  kind: Schema.Literal("warning"),
  message: Schema.String,
});

export const MigrateObservationContinuingEvent = Schema.Union([
  MigrateStateObservationEvent,
  MigrateProgressObservationEvent,
  MigrateWarningObservationEvent,
]);
export type MigrateObservationContinuingEvent =
  typeof MigrateObservationContinuingEvent.Type;

export const MigrateObservationEvent = Schema.Union([
  MigrateStateObservationEvent,
  MigrateProgressObservationEvent,
  MigrateWarningObservationEvent,
  MigrateDetachedObservationEvent,
  MigrateTerminalObservationEvent,
]);
export type MigrateObservationEvent = typeof MigrateObservationEvent.Type;

const MigrateObservationCompletionEvent = Schema.Union([
  MigrateDetachedObservationEvent,
  MigrateTerminalObservationEvent,
]);

const MigrateObservationCompletionEnvelope = Schema.Struct({
  resumeToken: MigrateObservationResumeToken,
  event: MigrateObservationCompletionEvent,
});

const MigrateObservationContinuingEnvelope = Schema.Struct({
  resumeToken: MigrateObservationResumeToken,
  event: MigrateObservationContinuingEvent,
});

export const MigrateObservationLease = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("heartbeat"),
  }),
  Schema.Struct({
    events: Schema.NonEmptyArray(MigrateObservationContinuingEnvelope),
    kind: Schema.Literal("continuing"),
    nextResumeToken: MigrateObservationResumeToken,
  }),
  Schema.Struct({
    event: MigrateObservationCompletionEnvelope,
    events: Schema.Array(MigrateObservationContinuingEnvelope),
    kind: Schema.Literal("terminal"),
  }),
]);
export type MigrateObservationLease = typeof MigrateObservationLease.Type;

export const MigrateRunStopResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("requested"),
    message: Schema.String,
    runId: MigrationRunId,
  }),
  Schema.Struct({
    kind: Schema.Literal("not-running"),
    message: Schema.String,
    runId: MigrationRunId,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    message: Schema.String,
    runId: MigrationRunId,
  }),
]);
export type MigrateRunStopResult = typeof MigrateRunStopResult.Type;

export const MigrateBreakLockResult = Schema.Struct({
  definitionId: MigrationDefinitionId,
  kind: Schema.Literals(["already-clear", "cleared"]),
});
export type MigrateBreakLockResult = typeof MigrateBreakLockResult.Type;

export class MigrateOperationError extends Schema.TaggedError<MigrateOperationError>()(
  "MigrateOperationError",
  {
    code: Schema.Literals(["execution-failed", "operation-failed"]),
    message: Schema.String,
  }
) {}

export class MigratePlanChangedError extends Schema.TaggedError<MigratePlanChangedError>()(
  "MigratePlanChangedError",
  {
    acceptedFingerprint: MigratePlanFingerprint,
    currentFingerprint: MigratePlanFingerprint,
    message: Schema.String,
  }
) {}

export const MigrateProtocolError = Schema.Union([
  MigrateOperationError,
  MigratePlanChangedError,
]);
export type MigrateProtocolError = typeof MigrateProtocolError.Type;

export class GetServerInfo extends makeRpc("GetServerInfo", {
  success: MigrateServerInfo,
}) {}

export class GetDashboard extends makeRpc("GetDashboard", {
  error: MigrateProtocolError,
  success: MigrateDashboardSnapshot,
}) {}

export class GetActiveRuns extends makeRpc("GetActiveRuns", {
  error: MigrateProtocolError,
  success: Schema.Array(MigrateActiveRun),
}) {}

export class GetMessages extends makeRpc("GetMessages", {
  error: MigrateProtocolError,
  payload: { target: MigrateTarget },
  success: Schema.Array(MigrationMessage),
}) {}

export class GetSourceIdentityHistory extends makeRpc(
  "GetSourceIdentityHistory",
  {
    error: MigrateProtocolError,
    payload: { definitionId: MigrationDefinitionId },
    success: Schema.Array(MigrateSourceIdentityHistoryEntry),
  }
) {}

export class GetSourceItemTotals extends makeRpc("GetSourceItemTotals", {
  error: MigrateProtocolError,
  payload: {
    definitionIds: MigrateDefinitionIds,
  },
  success: Schema.Array(MigrateDefinitionSourceItemTotal),
}) {}

export class NormalizeSourceIdentity extends makeRpc(
  "NormalizeSourceIdentity",
  {
    error: MigrateProtocolError,
    payload: {
      definitionId: MigrationDefinitionId,
      sourceIdentity: Schema.String,
    },
    success: Schema.String,
  }
) {}

export class PrepareOperation extends makeRpc("PrepareOperation", {
  error: MigrateProtocolError,
  payload: {
    action: MigrateAction,
    options: MigratePrepareOptions,
    target: MigrateTarget,
  },
  success: MigratePreparedOperation,
}) {}

export class StartOperation extends makeRpc("StartOperation", {
  error: MigrateProtocolError,
  payload: {
    acceptedFingerprint: MigratePlanFingerprint,
    request: MigrateOperationRequest,
  },
  success: MigrateRunStartResult,
}) {}

export class ObserveRun extends makeRpc("ObserveRun", {
  error: MigrateProtocolError,
  payload: { runId: MigrationRunId },
  stream: true,
  success: MigrateObservationEvent,
}) {}

export class ObserveDashboard extends makeRpc("ObserveDashboard", {
  error: MigrateProtocolError,
  payload: {
    after: Schema.optional(MigrateDashboardResumeToken),
  },
  stream: true,
  success: MigrateDashboardSnapshot,
}) {}

export class ObserveDashboardLease extends makeRpc("ObserveDashboardLease", {
  error: MigrateProtocolError,
  payload: {
    after: Schema.optional(MigrateDashboardResumeToken),
  },
  success: MigrateDashboardLease,
}) {}

export class ObserveRunLease extends makeRpc("ObserveRunLease", {
  error: MigrateProtocolError,
  payload: {
    after: Schema.optional(MigrateObservationResumeToken),
    runId: MigrationRunId,
  },
  success: MigrateObservationLease,
}) {}

export class StopRun extends makeRpc("StopRun", {
  error: MigrateProtocolError,
  payload: { runId: MigrationRunId },
  success: MigrateRunStopResult,
}) {}

export class ScanSource extends makeRpc("ScanSource", {
  error: MigrateProtocolError,
  payload: {
    concurrency: Schema.optional(PositiveInteger),
    target: MigrateTarget,
  },
  success: MigrateDashboard,
}) {}

export class BreakLock extends makeRpc("BreakLock", {
  error: MigrateProtocolError,
  payload: { lock: MigrationDefinitionLock },
  success: MigrateBreakLockResult,
}) {}

const MigrateControlRpcs = makeRpcGroup(
  GetServerInfo,
  GetDashboard,
  GetActiveRuns,
  GetMessages,
  GetSourceIdentityHistory,
  GetSourceItemTotals,
  NormalizeSourceIdentity,
  PrepareOperation,
  StartOperation,
  StopRun,
  ScanSource,
  BreakLock
);

/** RPC surface used by connection-oriented transports such as local IPC. */
export const MigrateStreamingRpcs = MigrateControlRpcs.add(
  ObserveDashboard,
  ObserveRun
);

/** RPC surface used by bounded request/response transports such as HTTPS. */
export const MigrateHttpRpcs = MigrateControlRpcs.add(
  ObserveDashboardLease,
  ObserveRunLease
);
