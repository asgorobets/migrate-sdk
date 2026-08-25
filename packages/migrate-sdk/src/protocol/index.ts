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

export const MIGRATE_PROTOCOL_VERSION = 2;

const PositiveInteger = Schema.Finite.check(Schema.isInt()).check(
  Schema.isGreaterThan(0)
);

export const MigrateProtocolVersion = PositiveInteger;
export type MigrateProtocolVersion = typeof MigrateProtocolVersion.Type;

export const MIGRATE_CAPABILITIES = [
  "active-runs",
  "break-lock",
  "cancel-execution",
  "dashboard",
  "messages",
  "normalize-source-identity",
  "observe-execution",
  "observe-run",
  "prepare-operation",
  "scan-source",
  "source-identity-history",
  "start-operation",
] as const;

export const MigrateCapability = Schema.Literals(MIGRATE_CAPABILITIES);
export type MigrateCapability = typeof MigrateCapability.Type;

export const MigrateEnvironmentInfo = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.optional(Schema.NonEmptyString),
});
export type MigrateEnvironmentInfo = typeof MigrateEnvironmentInfo.Type;

export const MigrateServerInfo = Schema.Struct({
  capabilities: Schema.Array(MigrateCapability),
  configPath: Schema.optional(Schema.String),
  environment: MigrateEnvironmentInfo,
  protocolVersion: MigrateProtocolVersion,
  registryId: Schema.optional(MigrationDefinitionRegistryId),
  runtime: Schema.Struct({
    name: Schema.String,
    version: Schema.String,
  }),
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

export const MigrateExecutionId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrateExecutionId")
);
export type MigrateExecutionId = typeof MigrateExecutionId.Type;

export const MigrateExecutionState = Schema.Union([
  Schema.Struct({
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("starting"),
  }),
  Schema.Struct({
    adapter: Schema.String,
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("running"),
    runId: MigrationRunId,
  }),
  Schema.Struct({
    adapter: Schema.String,
    definitionId: MigrationDefinitionId,
    executionId: Schema.String,
    kind: Schema.Literal("observing"),
    runId: MigrationRunId,
  }),
  Schema.Struct({
    definitionId: MigrationDefinitionId,
    kind: Schema.Literal("cancelling"),
    runId: Schema.optional(MigrationRunId),
  }),
]);
export type MigrateExecutionState = typeof MigrateExecutionState.Type;

export const MigrateExecutionReference = Schema.Struct({
  adapter: Schema.optional(Schema.String),
  executionId: MigrateExecutionId,
  lifecycle: Schema.Literals(["attached", "completed", "detached"]),
  providerExecutionId: Schema.optional(Schema.String),
  runId: MigrationRunId,
});
export type MigrateExecutionReference = typeof MigrateExecutionReference.Type;

export const MigrateObservationEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("state"),
    state: MigrateExecutionState,
  }),
  Schema.Struct({
    definitions: Schema.Array(MigrationDefinitionStatus),
    kind: Schema.Literal("progress"),
  }),
  Schema.Struct({
    kind: Schema.Literal("warning"),
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("detached"),
    message: Schema.String,
    runId: MigrationRunId,
  }),
  Schema.Struct({
    kind: Schema.Literal("terminal"),
    message: Schema.String,
    outcome: Schema.Literals(["cancelled", "completed", "failed"]),
    runId: MigrationRunId,
  }),
]);
export type MigrateObservationEvent = typeof MigrateObservationEvent.Type;

export const MigrateCancellationResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({
    kind: Schema.Literal("requested"),
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("detached"),
    message: Schema.String,
  }),
]);
export type MigrateCancellationResult = typeof MigrateCancellationResult.Type;

export const MigrateBreakLockResult = Schema.Struct({
  definitionId: MigrationDefinitionId,
  kind: Schema.Literals(["already-clear", "cleared"]),
});
export type MigrateBreakLockResult = typeof MigrateBreakLockResult.Type;

export class MigrateOperationError extends Schema.TaggedError<MigrateOperationError>()(
  "MigrateOperationError",
  {
    code: Schema.Literals([
      "bootstrap-failed",
      "execution-failed",
      "operation-failed",
      "protocol-mismatch",
    ]),
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

export class MigrateExecutionNotFoundError extends Schema.TaggedError<MigrateExecutionNotFoundError>()(
  "MigrateExecutionNotFoundError",
  {
    executionId: MigrateExecutionId,
    message: Schema.String,
  }
) {}

export const MigrateProtocolError = Schema.Union([
  MigrateExecutionNotFoundError,
  MigrateOperationError,
  MigratePlanChangedError,
]);
export type MigrateProtocolError = typeof MigrateProtocolError.Type;

export class GetServerInfo extends makeRpc("GetServerInfo", {
  success: MigrateServerInfo,
}) {}

export class GetDashboard extends makeRpc("GetDashboard", {
  error: MigrateProtocolError,
  success: MigrateDashboard,
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
  success: MigrateExecutionReference,
}) {}

export class ObserveExecution extends makeRpc("ObserveExecution", {
  error: MigrateProtocolError,
  payload: { executionId: MigrateExecutionId },
  stream: true,
  success: MigrateObservationEvent,
}) {}

export class ObserveRun extends makeRpc("ObserveRun", {
  error: MigrateProtocolError,
  payload: { runId: MigrationRunId },
  stream: true,
  success: MigrateObservationEvent,
}) {}

export class CancelExecution extends makeRpc("CancelExecution", {
  error: MigrateProtocolError,
  payload: { executionId: Schema.optional(MigrateExecutionId) },
  success: MigrateCancellationResult,
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

export const MigrateRpcs = makeRpcGroup(
  GetServerInfo,
  GetDashboard,
  GetActiveRuns,
  GetMessages,
  GetSourceIdentityHistory,
  NormalizeSourceIdentity,
  PrepareOperation,
  StartOperation,
  ObserveExecution,
  ObserveRun,
  CancelExecution,
  ScanSource,
  BreakLock
);
