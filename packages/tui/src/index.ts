// biome-ignore-all lint/performance/noBarrelFile: Package entrypoint intentionally exposes the public TUI API.

export { MigrationTuiApp } from "./app.tsx";
export type { MigrationTuiExecutionResult } from "./execution.ts";
export type {
  LoadLocalMigrationTuiInput,
  LoadMigrationTuiInput,
  LoadRemoteMigrationTuiInput,
  MigrationTuiDetachResult,
  MigrationTuiExecuteOptions,
  MigrationTuiRuntime,
  MigrationTuiScanSourceOptions,
  MigrationTuiSnapshot,
} from "./runtime.ts";
export { makeMigrationTuiRuntime } from "./server/tui-runtime.ts";
