// biome-ignore-all assist/source/organizeImports: Public core entrypoint grouped by domain concern.
// biome-ignore-all lint/performance/noBarrelFile: Core subpath intentionally avoids optional source and store implementations.

export { defineMigration } from "./domain/definition.ts";

export {
  executeMigrationExecutionEnvelope,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
} from "./domain/execution-envelope.ts";
export type {
  MigrationExecutionEnvelope as MigrationExecutionEnvelopeType,
  MigrationRollbackExecutionEnvelope as MigrationRollbackExecutionEnvelopeType,
  MigrationRunExecutionEnvelope as MigrationRunExecutionEnvelopeType,
} from "./domain/execution-envelope.ts";

export type { MigrationDefinitionId } from "./domain/ids.ts";
export { SourceIdentity, toMigrationDefinitionId } from "./domain/ids.ts";

export {
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryExecutableError,
} from "./domain/registry.ts";
export type { MigrationDefinitionRegistryPlanningError } from "./domain/registry.ts";

export type { MigrationRunSummary } from "./domain/run.ts";
export type { RollbackRunSummary } from "./domain/rollback.ts";

export { MigrationExecutable } from "./services/migration-executable.ts";
export type {
  MigrationExecutableRollbackError,
  MigrationExecutableRunError,
  MigrationExecutableService,
} from "./services/migration-executable.ts";
export { MigrationExecution } from "./services/migration-execution.ts";
export type {
  BoundMigrationExecutionService,
  MigrationExecutionMakeInput,
  MigrationExecutionRollbackError,
  MigrationExecutionRollbackInput,
  MigrationExecutionRunError,
  MigrationExecutionRunInput,
  MigrationExecutionService,
} from "./services/migration-execution.ts";
export { MigrationDefinitionRegistryCatalog } from "./services/migration-definition-registry-catalog.ts";
export type { MigrationDefinitionRegistryCatalogLookupError } from "./services/migration-definition-registry-catalog.ts";
export {
  MigrationRollbackExecutor,
  MigrationRunExecutor,
} from "./services/migration-run-executor.ts";
export type {
  MigrationRollbackExecutorService,
  MigrationRunExecutorService,
} from "./services/migration-run-executor.ts";
export { MigrationRunStepExecutor } from "./services/migration-run-step-executor.ts";
export type { MigrationRunStepExecutorService } from "./services/migration-run-step-executor.ts";
export type {
  MigrationRunCompletionInput,
  MigrationRunDefinitionCursorWindowInput,
  MigrationRunCursorWindowResult,
  MigrationRunCursorWindowState,
  MigrationRunExecutionLease,
  MigrationRunFailureInput,
} from "./runtime/run-migrations.ts";
