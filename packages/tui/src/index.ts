// biome-ignore-all lint/performance/noBarrelFile: Package entrypoint intentionally exposes the public TUI API.

export { MigrationTuiApp } from "./app.tsx";
export type {
  MigrationTuiCancellationResult,
  MigrationTuiExecutionResult,
  MigrationTuiExecutionState,
} from "./execution-controller.ts";
export type {
  LoadMigrationTuiInput,
  MigrationTuiAction,
  MigrationTuiBreakLockResult,
  MigrationTuiDependencyCheck,
  MigrationTuiExecuteOptions,
  MigrationTuiMessage,
  MigrationTuiPreparedOperation,
  MigrationTuiPrepareOptions,
  MigrationTuiRow,
  MigrationTuiRuntime,
  MigrationTuiScanSourceOptions,
  MigrationTuiSnapshot,
  MigrationTuiSourceIdentityHistoryEntry,
  MigrationTuiTarget,
} from "./runtime.ts";
export { makeMigrationTuiRuntime } from "./server/tui-runtime.ts";
