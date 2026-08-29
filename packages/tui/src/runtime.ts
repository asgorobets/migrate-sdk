import type {
  MigrationDefinitionLock,
  MigrationMessage,
  MigrationRunId,
} from "migrate-sdk";
import type {
  MigrateAction,
  MigrateActiveRun,
  MigrateBreakLockResult,
  MigrateDashboardResumeToken,
  MigrateDashboardRow,
  MigrateDefinitionIds,
  MigrateDefinitionSourceItemTotal,
  MigrateExecutionState,
  MigratePreparedOperation,
  MigratePrepareOptions,
  MigrateRegistryGroup,
  MigrateRunStartResult,
  MigrateRunStopResult,
  MigrateSelection,
  MigrateSourceIdentityHistoryEntry,
  MigrateTarget,
} from "migrate-sdk/protocol";
import type { MigrationTuiExecutionResult } from "./execution.ts";

export interface MigrationTuiScanSourceOptions {
  readonly concurrency?: number;
}

export interface MigrationTuiSnapshot {
  readonly activeRuns: readonly MigrateActiveRun[];
  readonly resumeToken: MigrateDashboardResumeToken;
  readonly rows: readonly MigrateDashboardRow[];
  readonly scannedSource: boolean;
}

export type MigrationTuiSourceScanSnapshot = Omit<
  MigrationTuiSnapshot,
  "resumeToken"
>;

export interface MigrationTuiExecuteOptions {
  readonly onObservationWarning?: (message: string) => void;
  readonly onProgress?: (progress: {
    readonly definitions: readonly NonNullable<MigrateDashboardRow["status"]>[];
  }) => void;
  readonly onProgressError?: (cause: unknown) => void;
  readonly onStateChange?: (state: MigrateExecutionState) => void;
  readonly signal?: AbortSignal;
}

export interface MigrationTuiDashboardObservationOptions {
  readonly after?: MigrateDashboardResumeToken | undefined;
  readonly onSnapshot: (snapshot: MigrationTuiSnapshot) => void;
  readonly signal?: AbortSignal;
}

export type MigrationTuiDetachResult =
  | { readonly kind: "idle" }
  | { readonly kind: "detached"; readonly message: string };

export interface MigrationTuiRuntime {
  readonly breakLock: (
    lock: MigrationDefinitionLock
  ) => Promise<MigrateBreakLockResult>;
  readonly detachForExit: () => Promise<MigrationTuiDetachResult>;
  readonly detachRunObservation: (runId?: MigrationRunId) => boolean;
  readonly dispose?: (() => Promise<void>) | undefined;
  readonly environmentLabel: string;
  readonly getSourceItemTotals: (
    definitionIds: MigrateDefinitionIds
  ) => Promise<readonly MigrateDefinitionSourceItemTotal[]>;
  readonly groups: readonly MigrateRegistryGroup[];
  readonly listActiveRuns: () => Promise<readonly MigrateActiveRun[]>;
  readonly listMessages: (
    target: MigrateTarget
  ) => Promise<readonly MigrationMessage[]>;
  readonly listSourceIdentityHistory: (
    definitionId: MigrateDashboardRow["entry"]["id"]
  ) => Promise<readonly MigrateSourceIdentityHistoryEntry[]>;
  readonly normalizeSourceIdentity: (
    definitionId: MigrateDashboardRow["entry"]["id"],
    sourceIdentity: string
  ) => Promise<string>;
  readonly observeDashboard: (
    options: MigrationTuiDashboardObservationOptions
  ) => Promise<void>;
  readonly observeRun: (
    runId: MigrationRunId,
    options?: MigrationTuiExecuteOptions
  ) => Promise<MigrationTuiExecutionResult>;
  readonly prepare: (
    selection: MigrateSelection,
    action: MigrateAction,
    options?: MigratePrepareOptions
  ) => Promise<MigratePreparedOperation>;
  readonly refresh: () => Promise<MigrationTuiSnapshot>;
  readonly rows: readonly MigrateDashboardRow[];
  readonly scanSource: (
    target: MigrateTarget,
    options?: MigrationTuiScanSourceOptions
  ) => Promise<MigrationTuiSourceScanSnapshot>;
  readonly start: (
    operation: MigratePreparedOperation
  ) => Promise<MigrateRunStartResult>;
  readonly stopRun: (runId: MigrationRunId) => Promise<MigrateRunStopResult>;
}

export interface LoadLocalMigrationTuiInput {
  readonly configPath?: string;
  readonly cwd: string;
  readonly server?: never;
}

export interface LoadRemoteMigrationTuiInput {
  readonly configPath?: never;
  readonly cwd?: never;
  readonly server: {
    readonly bearerToken?: string | undefined;
    readonly url: string;
  };
}

export type LoadMigrationTuiInput =
  | LoadLocalMigrationTuiInput
  | LoadRemoteMigrationTuiInput;
