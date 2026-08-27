import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { MigrationMessage } from "../domain/message.ts";
import {
  BreakLock,
  GetActiveRuns,
  GetDashboard,
  GetMessages,
  GetServerInfo,
  GetSourceIdentityHistory,
  MIGRATE_PROTOCOL_VERSION,
  MigrateAction,
  MigrateActiveRun,
  MigrateBreakLockResult,
  MigrateDashboard,
  MigrateDashboardLease,
  MigrateDashboardResumeToken,
  MigrateDashboardSnapshot,
  MigrateDependencyCheck,
  MigrateEnvironmentInfo,
  MigrateExecutionOptions,
  MigrateExecutionState,
  MigrateHttpRpcs,
  MigrateObservationEvent,
  MigrateObservationLease,
  MigrateObservationResumeToken,
  MigrateOperationError,
  MigrateOperationRequest,
  MigratePipelineConcurrency,
  MigratePlanChangedError,
  MigratePlanFingerprint,
  MigratePlanProjection,
  MigratePreparedOperation,
  MigratePrepareOptions,
  MigrateProtocolError,
  MigrateProtocolVersion,
  MigrateRegistryEntry,
  MigrateRegistryGroup,
  MigrateRunStartResult,
  MigrateServerInfo,
  MigrateSourceIdentityHistoryEntry,
  MigrateStreamingRpcs,
  MigrateTarget,
  NormalizeSourceIdentity,
  ObserveDashboard,
  ObserveDashboardLease,
  ObserveRun,
  ObserveRunLease,
  PrepareOperation,
  ScanSource,
  StartOperation,
  StopRun,
} from "./index.ts";

type ServiceFreeSchema = Schema.ConstraintDecoder<unknown> &
  Schema.ConstraintEncoder<unknown>;

const roundTrip = (schema: Schema.Top, value: unknown): unknown => {
  const serviceFreeSchema = schema as unknown as ServiceFreeSchema;
  const decoded = Schema.decodeUnknownSync(serviceFreeSchema)(value);
  return Schema.encodeUnknownSync(serviceFreeSchema)(decoded);
};

const messageBase = {
  definitionId: "articles",
  message: "Message",
  runId: "run-1",
  sourceIdentity: "article-1",
  updatedAt: "2026-08-24T12:00:00.000Z",
};

const dashboardValue = {
  activeRuns: [],
  groups: [{ definitionIds: ["articles"], id: "content" }],
  rows: [
    {
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: "articles",
      },
    },
  ],
  scannedSource: false,
};

const operationRequestValue = {
  action: "run",
  options: { withDependencies: true },
  target: { definitionId: "articles", kind: "migration" },
};

const preparedOperationValue = {
  action: "run",
  dependencyChecks: [
    {
      dependencyId: "authors",
      requiredByDefinitionId: "articles",
      satisfied: true,
    },
  ],
  fingerprint: "sha256:accepted-plan",
  observationDefinitionId: "articles",
  plan: {
    execution: {
      process: { concurrency: 4 },
      rollback: { concurrency: "unbounded" },
    },
    executionDefinitionIds: ["authors", "articles"],
    requestedDefinitionIds: ["articles"],
    withDependencies: true,
  },
  planRows: [
    {
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: "authors",
      },
    },
  ],
  request: {
    action: "run",
    options: {
      execution: {
        process: { concurrency: 4 },
        rollback: { concurrency: "unbounded" },
      },
      sourceIdentities: ["article-1", "article-2"],
      withDependencies: true,
    },
    target: { definitionId: "articles", kind: "migration" },
  },
  sourceIdentities: ["article-1", "article-2"],
  target: { definitionId: "articles", kind: "migration" },
};

const protocolErrorValue = {
  _tag: "MigrateOperationError",
  code: "operation-failed",
  message: "Operation failed",
};

const contractCases: readonly {
  readonly name: string;
  readonly schema: Schema.Top;
  readonly value: unknown;
}[] = [
  { name: "protocol version", schema: MigrateProtocolVersion, value: 1 },
  {
    name: "environment",
    schema: MigrateEnvironmentInfo,
    value: { id: "production", label: "Production" },
  },
  {
    name: "server info",
    schema: MigrateServerInfo,
    value: {
      environment: { id: "production" },
      protocolVersion: 1,
      registryId: "catalog",
      sdkVersion: "0.6.0",
    },
  },
  { name: "action", schema: MigrateAction, value: "rollback" },
  {
    name: "active migration run",
    schema: MigrateActiveRun,
    value: {
      definitionIds: ["authors", "articles"],
      execution: {
        adapter: "workflow-sdk",
        executionId: "workflow-run-1",
      },
      observationDefinitionId: "authors",
      runId: "run-1",
      startedAt: "2026-08-25T12:00:00.000Z",
      status: "running",
      stopSupported: false,
    },
  },
  {
    name: "migration target",
    schema: MigrateTarget,
    value: { definitionId: "articles", kind: "migration" },
  },
  {
    name: "group target",
    schema: MigrateTarget,
    value: { groupId: "content", kind: "group" },
  },
  {
    name: "bounded concurrency",
    schema: MigratePipelineConcurrency,
    value: 4,
  },
  {
    name: "unbounded concurrency",
    schema: MigratePipelineConcurrency,
    value: "unbounded",
  },
  {
    name: "execution options",
    schema: MigrateExecutionOptions,
    value: {
      process: { concurrency: 4 },
      rollback: { concurrency: "unbounded" },
    },
  },
  {
    name: "prepare options",
    schema: MigratePrepareOptions,
    value: {
      force: true,
      sourceIdentities: ["article-1"],
      withDependencies: true,
    },
  },
  {
    name: "operation request",
    schema: MigrateOperationRequest,
    value: operationRequestValue,
  },
  {
    name: "registry entry",
    schema: MigrateRegistryEntry,
    value: {
      dependencies: { optional: ["assets"], required: ["authors"] },
      group: "content",
      hasRollback: true,
      id: "articles",
    },
  },
  {
    name: "registry group",
    schema: MigrateRegistryGroup,
    value: { definitionIds: ["authors", "articles"], id: "content" },
  },
  {
    name: "dashboard",
    schema: MigrateDashboard,
    value: dashboardValue,
  },
  {
    name: "dashboard resume token",
    schema: MigrateDashboardResumeToken,
    value: "sha256:dashboard",
  },
  {
    name: "dashboard snapshot",
    schema: MigrateDashboardSnapshot,
    value: {
      dashboard: dashboardValue,
      resumeToken: "sha256:dashboard",
    },
  },
  {
    name: "dashboard observation lease",
    schema: MigrateDashboardLease,
    value: {
      kind: "snapshot",
      snapshot: {
        dashboard: dashboardValue,
        resumeToken: "sha256:dashboard",
      },
    },
  },
  {
    name: "dependency check",
    schema: MigrateDependencyCheck,
    value: {
      dependencyId: "authors",
      requiredByDefinitionId: "articles",
      satisfied: true,
    },
  },
  {
    name: "plan fingerprint",
    schema: MigratePlanFingerprint,
    value: "sha256:accepted-plan",
  },
  {
    name: "plan projection",
    schema: MigratePlanProjection,
    value: {
      executionDefinitionIds: ["authors", "articles"],
      requestedDefinitionIds: ["articles"],
      withDependencies: true,
    },
  },
  {
    name: "source identity history",
    schema: MigrateSourceIdentityHistoryEntry,
    value: {
      sourceIdentity: "article-1",
      status: "migrated",
      updatedAt: "2026-08-24T12:00:00.000Z",
    },
  },
  {
    name: "starting state",
    schema: MigrateExecutionState,
    value: { definitionId: "articles", kind: "starting" },
  },
  {
    name: "server-owned running state",
    schema: MigrateExecutionState,
    value: {
      adapter: "inline",
      definitionId: "articles",
      kind: "running",
      ownership: "server",
      runId: "run-1",
    },
  },
  {
    name: "provider-owned running state",
    schema: MigrateExecutionState,
    value: {
      adapter: "workflow",
      definitionId: "articles",
      executionId: "workflow-1",
      kind: "running",
      ownership: "provider",
      runId: "run-1",
    },
  },
  {
    name: "cancelling state",
    schema: MigrateExecutionState,
    value: { definitionId: "articles", kind: "cancelling", runId: "run-1" },
  },
  {
    name: "run start result",
    schema: MigrateRunStartResult,
    value: {
      runId: "run-1",
      status: "started",
    },
  },
  {
    name: "state observation",
    schema: MigrateObservationEvent,
    value: {
      kind: "state",
      state: { definitionId: "articles", kind: "starting" },
    },
  },
  {
    name: "progress observation",
    schema: MigrateObservationEvent,
    value: { definitions: [], kind: "progress" },
  },
  {
    name: "warning observation",
    schema: MigrateObservationEvent,
    value: { kind: "warning", message: "Following durable state" },
  },
  {
    name: "detached observation",
    schema: MigrateObservationEvent,
    value: {
      kind: "detached",
      message: "Run continues in the background",
      runId: "run-1",
    },
  },
  {
    name: "terminal observation",
    schema: MigrateObservationEvent,
    value: {
      kind: "terminal",
      message: "Run cancelled",
      outcome: "cancelled",
      runId: "run-1",
    },
  },
  {
    name: "observation resume token",
    schema: MigrateObservationResumeToken,
    value: "sha256:checkpoint",
  },
  {
    name: "observation lease",
    schema: MigrateObservationLease,
    value: {
      events: [
        {
          resumeToken: "sha256:checkpoint",
          event: { definitions: [], kind: "progress" },
        },
      ],
      kind: "continuing",
      nextResumeToken: "sha256:checkpoint",
    },
  },
  {
    name: "break lock result",
    schema: MigrateBreakLockResult,
    value: { definitionId: "articles", kind: "cleared" },
  },
  {
    name: "operation error",
    schema: MigrateOperationError,
    value: {
      _tag: "MigrateOperationError",
      code: "operation-failed",
      message: "Operation failed",
    },
  },
  {
    name: "plan changed error",
    schema: MigratePlanChangedError,
    value: {
      _tag: "MigratePlanChangedError",
      acceptedFingerprint: "sha256:accepted",
      currentFingerprint: "sha256:current",
      message: "Plan changed",
    },
  },
  {
    name: "protocol error union",
    schema: MigrateProtocolError,
    value: {
      _tag: "MigrateOperationError",
      code: "execution-failed",
      message: "Execution failed",
    },
  },
  {
    name: "item error message",
    schema: MigrationMessage,
    value: {
      ...messageBase,
      errorKind: "process",
      errorTag: "InvalidArticle",
      kind: "item-error",
      severity: "error",
    },
  },
  {
    name: "skip reason message",
    schema: MigrationMessage,
    value: { ...messageBase, kind: "skip-reason", severity: "info" },
  },
  {
    name: "update reason message",
    schema: MigrationMessage,
    value: { ...messageBase, kind: "update-reason", severity: "warning" },
  },
  {
    name: "process diagnostic message",
    schema: MigrationMessage,
    value: {
      ...messageBase,
      details: { field: "title" },
      kind: "process-diagnostic",
      sequence: 1,
      severity: "warning",
    },
  },
  {
    name: "rollback error message",
    schema: MigrationMessage,
    value: {
      ...messageBase,
      errorKind: "destination",
      errorTag: "RollbackFailed",
      kind: "rollback-error",
      severity: "error",
    },
  },
  {
    name: "rollback diagnostic message",
    schema: MigrationMessage,
    value: {
      ...messageBase,
      kind: "rollback-diagnostic",
      sequence: 2,
      severity: "info",
    },
  },
];

const rpcPayloadCases: readonly {
  readonly name: string;
  readonly schema: Schema.Top;
  readonly value: unknown;
}[] = [
  {
    name: "GetServerInfo",
    schema: GetServerInfo.payloadSchema,
    value: undefined,
  },
  {
    name: "GetDashboard",
    schema: GetDashboard.payloadSchema,
    value: undefined,
  },
  {
    name: "GetActiveRuns",
    schema: GetActiveRuns.payloadSchema,
    value: undefined,
  },
  {
    name: "GetMessages",
    schema: GetMessages.payloadSchema,
    value: { target: operationRequestValue.target },
  },
  {
    name: "GetSourceIdentityHistory",
    schema: GetSourceIdentityHistory.payloadSchema,
    value: { definitionId: "articles" },
  },
  {
    name: "NormalizeSourceIdentity",
    schema: NormalizeSourceIdentity.payloadSchema,
    value: { definitionId: "articles", sourceIdentity: "article-1" },
  },
  {
    name: "PrepareOperation",
    schema: PrepareOperation.payloadSchema,
    value: operationRequestValue,
  },
  {
    name: "StartOperation",
    schema: StartOperation.payloadSchema,
    value: {
      acceptedFingerprint: "sha256:accepted-plan",
      request: operationRequestValue,
    },
  },
  {
    name: "ObserveRun",
    schema: ObserveRun.payloadSchema,
    value: { runId: "run-1" },
  },
  {
    name: "ObserveDashboard",
    schema: ObserveDashboard.payloadSchema,
    value: { after: "sha256:dashboard" },
  },
  {
    name: "ObserveDashboardLease",
    schema: ObserveDashboardLease.payloadSchema,
    value: { after: "sha256:dashboard" },
  },
  {
    name: "ObserveRunLease",
    schema: ObserveRunLease.payloadSchema,
    value: { after: "sha256:checkpoint", runId: "run-1" },
  },
  {
    name: "StopRun",
    schema: StopRun.payloadSchema,
    value: { runId: "run-1" },
  },
  {
    name: "ScanSource",
    schema: ScanSource.payloadSchema,
    value: { concurrency: 4, target: operationRequestValue.target },
  },
  {
    name: "BreakLock",
    schema: BreakLock.payloadSchema,
    value: {
      lock: {
        createdAt: new Date("2026-08-24T12:00:00.000Z"),
        definitionId: "articles",
        ownerRunId: "run-1",
        token: "lock-1",
      },
    },
  },
];

const rpcUnarySuccessCases: readonly {
  readonly name: string;
  readonly schema: Schema.Top;
  readonly value: unknown;
}[] = [
  {
    name: "GetServerInfo",
    schema: GetServerInfo.successSchema,
    value: {
      environment: { id: "production" },
      protocolVersion: 1,
      registryId: "catalog",
      sdkVersion: "0.6.0",
    },
  },
  {
    name: "GetDashboard",
    schema: GetDashboard.successSchema,
    value: {
      dashboard: dashboardValue,
      resumeToken: "sha256:dashboard",
    },
  },
  {
    name: "ObserveDashboardLease",
    schema: ObserveDashboardLease.successSchema,
    value: {
      kind: "snapshot",
      snapshot: {
        dashboard: dashboardValue,
        resumeToken: "sha256:dashboard",
      },
    },
  },
  {
    name: "GetActiveRuns",
    schema: GetActiveRuns.successSchema,
    value: [],
  },
  { name: "GetMessages", schema: GetMessages.successSchema, value: [] },
  {
    name: "GetSourceIdentityHistory",
    schema: GetSourceIdentityHistory.successSchema,
    value: [],
  },
  {
    name: "NormalizeSourceIdentity",
    schema: NormalizeSourceIdentity.successSchema,
    value: "article-1",
  },
  {
    name: "PrepareOperation",
    schema: PrepareOperation.successSchema,
    value: preparedOperationValue,
  },
  {
    name: "StartOperation",
    schema: StartOperation.successSchema,
    value: {
      runId: "run-1",
      status: "started",
    },
  },
  {
    name: "StopRun",
    schema: StopRun.successSchema,
    value: {
      kind: "requested",
      message: "Stopping run run-1",
      runId: "run-1",
    },
  },
  {
    name: "ScanSource",
    schema: ScanSource.successSchema,
    value: dashboardValue,
  },
  {
    name: "BreakLock",
    schema: BreakLock.successSchema,
    value: { definitionId: "articles", kind: "cleared" },
  },
];

const rpcErrorCases = [
  GetActiveRuns,
  GetDashboard,
  ObserveDashboardLease,
  GetMessages,
  GetSourceIdentityHistory,
  NormalizeSourceIdentity,
  PrepareOperation,
  StartOperation,
  StopRun,
  ScanSource,
  BreakLock,
] as const;

describe("Migrate Protocol", () => {
  it("keeps streaming observation off the bounded HTTP RPC surface", () => {
    expect(MigrateHttpRpcs.requests.has("ObserveDashboard")).toBe(false);
    expect(MigrateHttpRpcs.requests.has("ObserveDashboardLease")).toBe(true);
    expect(MigrateHttpRpcs.requests.has("ObserveRun")).toBe(false);
    expect(MigrateHttpRpcs.requests.has("ObserveRunLease")).toBe(true);
    expect(MigrateStreamingRpcs.requests.has("ObserveDashboard")).toBe(true);
    expect(MigrateStreamingRpcs.requests.has("ObserveDashboardLease")).toBe(
      false
    );
    expect(MigrateStreamingRpcs.requests.has("ObserveRun")).toBe(true);
    expect(MigrateStreamingRpcs.requests.has("ObserveRunLease")).toBe(false);
  });

  for (const contract of contractCases) {
    it(`round-trips ${contract.name}`, () => {
      expect(roundTrip(contract.schema, contract.value)).toEqual(
        contract.value
      );
    });
  }

  for (const contract of rpcPayloadCases) {
    it(`round-trips the ${contract.name} payload schema`, () => {
      expect(roundTrip(contract.schema, contract.value)).toEqual(
        contract.value
      );
    });
  }

  for (const contract of rpcUnarySuccessCases) {
    it(`round-trips the ${contract.name} success schema`, () => {
      expect(roundTrip(contract.schema, contract.value)).toEqual(
        contract.value
      );
    });
  }

  for (const rpc of rpcErrorCases) {
    it(`round-trips the ${rpc._tag} error schema`, () => {
      expect(roundTrip(rpc.errorSchema, protocolErrorValue)).toEqual(
        protocolErrorValue
      );
    });
  }

  it("round-trips a serializable prepared operation", () => {
    const prepared = Schema.decodeUnknownSync(MigratePreparedOperation)(
      preparedOperationValue
    );

    const encoded = Schema.encodeSync(MigratePreparedOperation)(prepared);

    expect(encoded).toEqual(preparedOperationValue);
    expect("definitions" in prepared.plan).toBe(false);
    expect(MIGRATE_PROTOCOL_VERSION).toBe(1);
  });

  it("rejects an active run without any definitions", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateActiveRun)({
        definitionIds: [],
        observationDefinitionId: "articles",
        runId: "run-empty",
        startedAt: "2026-08-25T12:00:00.000Z",
        status: "running",
        stopSupported: false,
      })
    ).toThrow();
  });

  it("rejects an active run whose observation definition is outside the run", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateActiveRun)({
        definitionIds: ["articles"],
        observationDefinitionId: "authors",
        runId: "run-invalid-anchor",
        startedAt: "2026-08-25T12:00:00.000Z",
        status: "running",
        stopSupported: false,
      })
    ).toThrow();
  });

  it("rejects an active run without explicit stop support", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateActiveRun)({
        definitionIds: ["articles"],
        observationDefinitionId: "articles",
        runId: "run-missing-stop-support",
        startedAt: "2026-08-25T12:00:00.000Z",
        status: "running",
      })
    ).toThrow();
  });

  it("rejects a terminal observation lease without a terminal event", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateObservationLease)({
        events: [],
        kind: "terminal",
      })
    ).toThrow();
  });

  it("accepts lifecycle state batched with terminal completion", () => {
    expect(
      Schema.decodeUnknownSync(MigrateObservationLease)({
        event: {
          resumeToken: "sha256:terminal",
          event: {
            kind: "terminal",
            message: "Run completed",
            outcome: "completed",
            runId: "run-1",
          },
        },
        events: [
          {
            resumeToken: "sha256:state",
            event: {
              kind: "state",
              state: {
                adapter: "workflow-sdk",
                definitionId: "articles",
                executionId: "workflow-run-1",
                kind: "running",
                ownership: "provider",
                runId: "run-1",
              },
            },
          },
        ],
        kind: "terminal",
      })
    ).toMatchObject({
      events: [{ event: { kind: "state" } }],
      kind: "terminal",
    });
  });

  it("rejects a terminal event inside a continuing observation lease", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateObservationLease)({
        events: [
          {
            resumeToken: "sha256:terminal",
            event: {
              kind: "terminal",
              message: "Run completed",
              outcome: "completed",
              runId: "run-1",
            },
          },
        ],
        kind: "continuing",
        nextResumeToken: "sha256:terminal",
      })
    ).toThrow();
  });

  it("rejects continuing observation events without a resume token", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateObservationLease)({
        events: [
          {
            resumeToken: "sha256:checkpoint",
            event: { definitions: [], kind: "progress" },
          },
        ],
        kind: "continuing",
      })
    ).toThrow();
  });

  it("rejects an empty continuing observation lease", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateObservationLease)({
        events: [],
        kind: "continuing",
        nextResumeToken: "sha256:checkpoint",
      })
    ).toThrow();
  });

  it("accepts an observation heartbeat without a resume token", () => {
    expect(
      Schema.decodeUnknownSync(MigrateObservationLease)({ kind: "heartbeat" })
    ).toEqual({ kind: "heartbeat" });
  });

  it("rejects invalid protocol concurrency", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigratePreparedOperation)({
        action: "run",
        dependencyChecks: [],
        fingerprint: "sha256:invalid-plan",
        observationDefinitionId: "articles",
        plan: {
          execution: { process: { concurrency: 0 } },
          executionDefinitionIds: ["articles"],
          requestedDefinitionIds: ["articles"],
          withDependencies: false,
        },
        planRows: [],
        request: {
          action: "run",
          options: { execution: { process: { concurrency: 0 } } },
          target: { definitionId: "articles", kind: "migration" },
        },
        target: { definitionId: "articles", kind: "migration" },
      })
    ).toThrow();
  });

  it("decodes future protocol versions before compatibility negotiation", () => {
    const info = Schema.decodeUnknownSync(MigrateServerInfo)({
      environment: { id: "production", label: "Production" },
      protocolVersion: MIGRATE_PROTOCOL_VERSION + 1,
      registryId: "catalog",
      sdkVersion: "0.6.0",
    });

    expect(info.protocolVersion).toBe(MIGRATE_PROTOCOL_VERSION + 1);
  });

  it("can reject excess public protocol fields during strict decoding", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrateServerInfo, {
        onExcessProperty: "error",
      })({
        environment: { id: "production" },
        extra: true,
        protocolVersion: 1,
        sdkVersion: "0.6.0",
      })
    ).toThrow();
  });
});
