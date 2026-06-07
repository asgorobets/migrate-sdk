// biome-ignore-all assist/source/organizeImports: Public SDK entrypoint is grouped by domain for readability.
// biome-ignore-all lint/performance/noBarrelFile: Public package entrypoint intentionally re-exports the SDK surface.

export type {
  ConfiguredDestinationPlugin,
  ConfiguredSourcePlugin,
  DestinationRetryStrategy,
  MigrationDefinition,
  MigrationDefinitionInput,
  SourceReadResultInput,
  SourcePluginFactoryInput,
  SourcePluginImplementation,
  SourcePluginInput,
  SourceRetryStrategy,
} from "./domain/definition.ts";
export {
  defineMigration,
  defineSourcePlugin,
} from "./domain/definition.ts";

export type {
  DefinedDestinationCommands,
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandDefinition,
  DestinationCommandPlan,
  DestinationCommandResult,
  DestinationCommandResultInput,
  DestinationCommandSchema,
} from "./domain/destination.ts";
export { makeDestinationCommandResult } from "./domain/destination.ts";

export type {
  DefinedDestinationCommandGroup,
  DefinedDestinationCommand,
  DestinationCommandHandler,
  DestinationCommandHandlerContext,
} from "./domain/destination-plugin-definition.ts";
export {
  defineDestinationCommand,
  defineDestinationCommandGroup,
  defineDestinationPlugin,
} from "./domain/destination-plugin-definition.ts";

export {
  DestinationPluginError,
  makeSkipItem,
  MigrationReferenceLookupError,
  MigrationRuntimeError,
  MigrationStoreError,
  RollbackPreflightError,
  RollbackRequestError,
  skipItem,
  SkipItem,
  SourcePluginError,
} from "./domain/errors.ts";

export type {
  DestinationIdentityInput,
  DestinationVersionInput,
  EncodedSourceCursorInput,
  MigrationDefinitionIdInput,
  MigrationDefinitionLockTokenInput,
  MigrationRunIdInput,
  SourceIdentityInput,
  SourceVersionInput,
} from "./domain/ids.ts";
export {
  DestinationIdentity,
  DestinationVersion,
  EncodedSourceCursor,
  MigrationDefinitionId,
  MigrationDefinitionLockToken,
  MigrationRunId,
  SourceIdentity,
  SourceVersion,
  toDestinationIdentity,
  toDestinationVersion,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "./domain/ids.ts";

export { MigrationDefinitionLock } from "./domain/lock.ts";

export type { PipelineContext } from "./domain/pipeline.ts";

export { MigrationRunState } from "./domain/run.ts";
export type {
  MigrationDefinitionRunSummary,
  MigrationRunSummary,
  RunRequest,
  RunRequestInput,
} from "./domain/run.ts";

export {
  makeRollbackMigrationOptions,
  makeRollbackRequest,
  RollbackContext,
  RollbackDefinitionRunSummary,
  RollbackMigrationOptions,
  RollbackRunSummary,
} from "./domain/rollback.ts";
export type {
  AnyRollbackMigrationDefinition,
  MigrationDefinitionRollbackPipelineError,
  RollbackableMigrationItemState,
  RollbackMigrationOptionsInput,
  RollbackPipeline,
  RollbackRequest,
  RollbackRequestInput,
} from "./domain/rollback.ts";

export type { RunMode, RunModeInput } from "./domain/run-mode.ts";

export type {
  SourceItem,
  SourceItemInput,
  SourceLookupStrategy,
  SourceReadResult,
} from "./domain/source.ts";
export { makeSourceItem } from "./domain/source.ts";

export {
  FailedItemState,
  MigratedItemState,
  MigrationItemError,
  MigrationItemErrorKind,
  MigrationItemState,
  NeedsUpdateItemState,
  SkippedItemState,
} from "./domain/state.ts";
export type {
  MigrationItemOutcome,
  MigrationItemStateBase,
} from "./domain/state.ts";

export { DestinationPlugin } from "./services/destination-plugin.ts";
export { MigrationReferenceLookup } from "./services/migration-reference-lookup.ts";
export type {
  MigrationReference,
  MigrationReferenceLookupInput,
} from "./services/migration-reference-lookup.ts";
export { MigrationStore } from "./services/migration-store.ts";
export { SourcePlugin } from "./services/source-plugin.ts";

export {
  rollbackMigration,
  runMigration,
  runMigrations,
} from "./runtime/run-migrations.ts";
export type {
  RollbackMigrationError,
  RunMigrationError,
} from "./runtime/run-migrations.ts";

export { InMemoryDestinationPlugin } from "./destinations/in-memory/in-memory-destination.ts";
export type {
  InMemoryEntryCommand,
  InMemoryEntryDestination,
  InMemoryEntryDestinationCommandOptions,
  InMemoryEntryDestinationCommands,
  InMemoryEntryDestinationOptions,
  InMemoryEntryFieldSchema,
  InMemoryPublishEntryCommand,
  InMemoryPublishEntryCommandOptions,
  InMemoryDestinationTransientFailures,
  InMemoryUpsertEntryCommand,
  InMemoryUpsertEntryCommandOptions,
} from "./destinations/in-memory/in-memory-destination.ts";

export { InMemorySourcePlugin } from "./sources/in-memory/in-memory-source.ts";
export { InMemorySourceCursor } from "./sources/in-memory/in-memory-source.ts";
export type {
  InMemorySourceOptions,
  InMemorySourceState,
  InMemorySourceTransientFailures,
} from "./sources/in-memory/in-memory-source.ts";

export {
  CsvSourceCursor,
  CsvSourcePlugin,
} from "./sources/csv/csv-source.ts";
export type {
  CsvDialect,
  CsvEmptyRows,
  CsvHeaders,
  CsvIdentity,
  CsvSourceOptions,
  CsvSourcePlatform,
  CsvVersion,
} from "./sources/csv/csv-source.ts";

export { InMemoryMigrationStore } from "./stores/in-memory/in-memory-migration-store.ts";
export type { InMemoryMigrationStoreState } from "./stores/in-memory/in-memory-migration-store.ts";

export {
  FileMigrationStore,
  FileMigrationStorePlatform,
} from "./stores/file/file-migration-store.ts";
export type { FileMigrationStoreOptions } from "./stores/file/file-migration-store.ts";
