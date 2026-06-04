export type {
  ConfiguredDestinationPlugin,
  ConfiguredSourcePlugin,
  DestinationRetryStrategy,
  MigrationDefinition,
  MigrationDefinitionInput,
  SourceRetryStrategy,
} from "./domain/definition.ts";
export { defineMigration } from "./domain/definition.ts";

export type {
  DestinationCommand,
  DestinationCommandContext,
  DestinationCommandResult,
  DestinationCommandResultInput,
} from "./domain/destination.ts";
export { makeDestinationCommandResult } from "./domain/destination.ts";

export {
  DestinationPluginError,
  makeSkipItem,
  MigrationRuntimeError,
  MigrationStoreError,
  skipItem,
  SkipItem,
  SourcePluginError,
} from "./domain/errors.ts";

export type {
  DestinationIdentityInput,
  DestinationVersionInput,
  MigrationDefinitionIdInput,
  MigrationRunIdInput,
  SourceCursor,
  SourceIdentityInput,
  SourceVersionInput,
} from "./domain/ids.ts";
export {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
  SourceVersion,
  toDestinationIdentity,
  toDestinationVersion,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "./domain/ids.ts";

export { MigrationDefinitionLock } from "./domain/lock.ts";
export type { MigrationDefinitionLock as MigrationDefinitionLockType } from "./domain/lock.ts";

export type { PipelineContext } from "./domain/pipeline.ts";

export { MigrationRunState } from "./domain/run.ts";
export type {
  MigrationDefinitionRunSummary,
  MigrationRunState as MigrationRunStateType,
  MigrationRunSummary,
  RunRequest,
  RunRequestInput,
} from "./domain/run.ts";

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
  FailedItemState as FailedItemStateType,
  MigratedItemState as MigratedItemStateType,
  MigrationItemError as MigrationItemErrorType,
  MigrationItemErrorKind as MigrationItemErrorKindType,
  MigrationItemOutcome,
  MigrationItemState as MigrationItemStateType,
  MigrationItemStateBase,
  NeedsUpdateItemState as NeedsUpdateItemStateType,
  SkippedItemState as SkippedItemStateType,
} from "./domain/state.ts";

export { DestinationPlugin } from "./services/destination-plugin.ts";
export { MigrationStore } from "./services/migration-store.ts";
export type { AnySourcePlugin } from "./services/source-plugin.ts";
export { SourcePlugin } from "./services/source-plugin.ts";

export { runMigration, runMigrations } from "./runtime/run-migrations.ts";
export type { RunMigrationError } from "./runtime/run-migrations.ts";

export {
  InMemoryDestinationPlugin,
} from "./destinations/in-memory/in-memory-destination.ts";
export type {
  InMemoryDestinationExecution,
  InMemoryDestinationOptions,
  InMemoryDestinationState,
  InMemoryDestinationTransientFailures,
} from "./destinations/in-memory/in-memory-destination.ts";

export { InMemorySourcePlugin } from "./sources/in-memory/in-memory-source.ts";
export type {
  InMemorySourceOptions,
  InMemorySourceState,
  InMemorySourceTransientFailures,
} from "./sources/in-memory/in-memory-source.ts";

export { InMemoryMigrationStore } from "./stores/in-memory/in-memory-migration-store.ts";
export type { InMemoryMigrationStoreState } from "./stores/in-memory/in-memory-migration-store.ts";
