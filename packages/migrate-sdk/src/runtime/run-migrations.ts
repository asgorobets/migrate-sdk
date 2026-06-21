// biome-ignore-all lint/performance/noBarrelFile: Compatibility module. Execution is implemented by services under ../services.

export type {
  MigrationRunBeginInput,
  MigrationRunCompletionInput,
  MigrationRunCursorWindowInput,
  MigrationRunCursorWindowResult,
  MigrationRunCursorWindowState,
  MigrationRunDefinitionCursorWindowInput,
  MigrationRunExecutionLease,
  MigrationRunFailureInput,
  MigrationRuntimeExecutionOptions,
  RollbackMigrationDefinitionError,
  RollbackMigrationError,
  RunMigrationDefinitionError,
  RunMigrationError,
} from "../services/migration-run-executor.ts";
export {
  emptyMigrationRunCursorWindowState,
  rollbackMigration,
  rollbackMigrations,
  rollbackMigrationsWithEncodedSourceIdentities,
  runMigration,
  runMigrations,
  runMigrationsWithEncodedRunMode,
} from "../services/migration-run-executor.ts";
