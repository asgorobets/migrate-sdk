// biome-ignore-all assist/source/organizeImports: Public SDK entrypoint is grouped by domain for readability.
// biome-ignore-all lint/performance/noBarrelFile: Public package entrypoint intentionally re-exports the SDK surface.

export type {
  ConfiguredDestinationPlugin,
  ConfiguredSourcePlugin,
  DestinationRetryStrategy,
  MigrationDefinitionDependencies,
  MigrationDefinitionDependenciesInput,
  MigrationDefinition,
  MigrationDefinitionInput,
  SourcePayloadSchema,
  SourceReadResultInput,
  SourcePluginFactoryInput,
  SourcePluginImplementation,
  SourcePluginInput,
  SourceRetryStrategy,
} from "./domain/definition.ts";
export { defineMigration, defineSourcePlugin } from "./domain/definition.ts";

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
  EncodedSourceIdentityInput,
  DestinationIdentityInput,
  DestinationVersionInput,
  EncodedSourceCursorInput,
  MigrationDefinitionIdInput,
  MigrationDefinitionLockTokenInput,
  MigrationRunIdInput,
  SourceIdentityContractFingerprint,
  SourceIdentityDefinition,
  SourceIdentitySchema,
  SourceIdentitySnapshot,
  SourceIdentitySnapshotKey,
  SourceIdentityTarget,
  SourceVersionInput,
} from "./domain/ids.ts";
export {
  DestinationIdentity,
  DestinationVersion,
  EncodedSourceIdentity,
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
  toEncodedSourceIdentity,
  toSourceVersion,
} from "./domain/ids.ts";

export type {
  MigrationContract,
  SourceVersionContractIdInput,
  SourceVersionContractFingerprintInput,
  TrackingRecordContractIdInput,
  TrackingRecordContractFingerprintInput,
} from "./domain/migration-contract.ts";
export {
  SourceVersionContractId,
  SourceVersionContractFingerprint,
  TrackingRecordContractId,
  TrackingRecordContractFingerprint,
  defaultSourceVersionContractFingerprint,
  makeSourceIdentityContractFingerprint,
  makeSourceVersionContractFingerprint,
  makeTrackingRecordContractFingerprint,
} from "./domain/migration-contract.ts";

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
  DuplicateSourceIdentityStatusWarning,
  InvalidSourceItemStatusWarning,
  makeMigrationStatusRequest,
  MigrationDefinitionSourceStatus,
  MigrationDefinitionStatus,
  MigrationItemStateSummary,
  MigrationStatusReport,
  MigrationStatusRequestError,
  MigrationStatusWarning,
} from "./domain/status.ts";
export type {
  GetMigrationStatusesError,
  MigrationStatusRequest,
  MigrationStatusRequestInput,
} from "./domain/status.ts";

export {
  DuplicateMigrationDefinitionId,
  MigrationDefinitionDuplicateRequestedDefinitionIgnored,
  MigrationDefinitionDuplicateSourceIdentityTargetIgnored,
  MigrationDefinitionOptionalDependencyCycleIgnored,
  MigrationDefinitionPlanNotice,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionError,
  MigrationDefinitionRegistryConstructionIssue,
  MigrationDefinitionRegistryInvalidSelectionError,
  MigrationDefinitionRegistryLookupError,
  MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError,
  MigrationDefinitionRegistryUnknownDefinitionError,
  MissingRequiredMigrationDefinitionDependency,
  RequiredMigrationDefinitionDependencyCycle,
} from "./domain/registry.ts";
export type {
  MigrationDefinitionDependencyEdge,
  MigrationDefinitionPlanTarget,
  MigrationDefinitionRegistryEntry,
  MigrationDefinitionRegistryInput,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistryRollbackError,
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryRunError,
  MigrationDefinitionRegistryRunInput,
  MigrationDefinitionRegistrySelectionInput,
  MigrationDefinitionRegistryStatusError,
  MigrationDefinitionRegistryStatusInput,
  MigrationDefinitionRegistryStatusReport,
  MigrationDefinitionRollbackPlan,
  MigrationDefinitionRunPlan,
} from "./domain/registry.ts";

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

export type { RunModeInput } from "./domain/run-mode.ts";

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

export {
  DestinationChangeDescriptor,
  DestinationChangeDescriptorId,
  DestinationJournal,
  DestinationJournalChangeEntry,
  DestinationJournalEntry,
  DestinationJournalSegment,
  TrackingRecord,
  TrackingRecordContract,
} from "./domain/tracking.ts";
export type {
  DestinationChangeDescriptor as DestinationChangeDescriptorType,
  DestinationChangeValue,
  DestinationJournalChangeEntry as DestinationJournalChangeEntryType,
  DestinationJournalEntry as DestinationJournalEntryType,
  DestinationJournalSegment as DestinationJournalSegmentType,
  TrackingRecordContract as TrackingRecordContractType,
  TrackingRecordContractInput,
  TrackingRecordValue,
} from "./domain/tracking.ts";

export { DestinationPlugin } from "./services/destination-plugin.ts";
export { MigrationReferenceLookup } from "./services/migration-reference-lookup.ts";
export type {
  MigrationReference,
  MigrationReferenceForDefinition,
  MigrationReferenceLookupInput,
  MigrationReferenceLookupTarget,
} from "./services/migration-reference-lookup.ts";
export { MigrationStore } from "./services/migration-store.ts";
export { SourcePlugin } from "./services/source-plugin.ts";
export { Tracking } from "./services/tracking.ts";
export type {
  TrackingProcessContext,
  TrackingService,
} from "./services/tracking.ts";

export { getMigrationStatuses } from "./runtime/get-migration-statuses.ts";
export {
  rollbackMigration,
  rollbackMigrations,
  runMigration,
  runMigrations,
} from "./runtime/run-migrations.ts";
export type {
  RollbackMigrationError,
  RunMigrationError,
} from "./runtime/run-migrations.ts";

export {
  InMemoryDestination,
  InMemoryDestinationPlugin,
} from "./destinations/in-memory/in-memory-destination.ts";
export type {
  InMemoryDeleteEntryCommand,
  InMemoryDeleteEntryCommandOptions,
  InMemoryEntryDestinationModule,
  InMemoryEntryDestinationModuleOptions,
  InMemoryEntryCommand,
  InMemoryEntryDestination,
  InMemoryEntryDestinationCommandOptions,
  InMemoryEntryDestinationCommands,
  InMemoryEntryDestinationOptions,
  InMemoryEntryFieldSchema,
  InMemoryPublishEntryCommand,
  InMemoryPublishEntryCommandOptions,
  InMemoryDestinationTransientFailures,
  InMemoryEntryUpsertedChange,
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
  CsvIdentity,
  CsvSourceCursor,
  CsvSourcePlugin,
} from "./sources/csv/csv-source.ts";
export type {
  CsvCompositeIdentityKey,
  CsvDialect,
  CsvEmptyRows,
  CsvHeaders,
  CsvIdentityDefinition,
  CsvIdentityKeySelector,
  CsvSourceOptions,
  CsvSourcePlatform,
  CsvVersion,
} from "./sources/csv/csv-source.ts";

export {
  SqlIdentity,
  SqlSourcePlugin,
  SqlSourcePluginName,
} from "./sources/sql/sql-source.ts";
export type {
  AnySqlIdentityDefinition,
  SqlIdentityColumn,
  SqlIdentityColumns,
  SqlIdentityDefinition,
  SqlSourceLookup,
  SqlSourceMetadata,
  SqlSourceMetadataContext,
  SqlSourceMetadataFailure,
  SqlSourceMetadataResult,
  SqlSourceMetadataSuccess,
  SqlSourceOptions,
  SqlSourceRead,
} from "./sources/sql/sql-source.ts";

export { InMemoryMigrationStore } from "./stores/in-memory/in-memory-migration-store.ts";
export type { InMemoryMigrationStoreState } from "./stores/in-memory/in-memory-migration-store.ts";

export {
  FileMigrationStore,
  FileMigrationStorePlatform,
} from "./stores/file/file-migration-store.ts";
export type { FileMigrationStoreOptions } from "./stores/file/file-migration-store.ts";
