// biome-ignore-all assist/source/organizeImports: Public SDK entrypoint is grouped by domain for readability.
// biome-ignore-all lint/performance/noBarrelFile: Public package entrypoint intentionally re-exports the SDK surface.

export type {
  ConfiguredSourcePlugin,
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
export {
  defineMigration,
  defineSourcePlugin,
  defineSourcePluginLayer,
} from "./domain/definition.ts";

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
  MigrationExecutionOptions,
  NormalizedMigrationExecutionOptions,
  NormalizedPipelineExecutionOptions,
  PipelineExecutionConcurrency,
  PipelineExecutionOptions,
} from "./domain/execution.ts";

export type {
  EncodedSourceIdentityInput,
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
  EncodedSourceIdentity,
  EncodedSourceCursor,
  MigrationDefinitionId,
  MigrationDefinitionLockToken,
  MigrationRunId,
  SourceIdentity,
  SourceIdentitySnapshot as SourceIdentitySnapshotSchema,
  SourceVersion,
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
  MigrationContract as MigrationContractSchema,
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

export type { ProcessContext } from "./domain/pipeline.ts";

export type {
  MigrationDefinitionProgressState,
  MigrationProgressDefinitionStatus,
  MigrationProgressCounts,
  MigrationProgressEvent,
  MigrationProgressRunStatus,
  MigrationProgressState,
} from "./domain/progress.ts";
export {
  emptyMigrationProgressCounts,
  initialMigrationProgressState,
  reduceMigrationProgressState,
} from "./domain/progress.ts";

export type {
  RollbackDefinitionProgressState,
  RollbackProgressCounts,
  RollbackProgressDefinitionStatus,
  RollbackProgressEvent,
  RollbackProgressOutcome,
  RollbackProgressRunStatus,
  RollbackProgressState,
} from "./domain/rollback-progress.ts";
export {
  emptyRollbackProgressCounts,
  initialRollbackProgressState,
  reduceRollbackProgressState,
} from "./domain/rollback-progress.ts";

export { MigrationRunState } from "./domain/run.ts";
export type {
  ExecutionStartResult,
  MigrationExecutionHandle,
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
  DurableMigrationStatusRequestInput,
  GetMigrationStatusesError,
  MigrationStatusRequest,
  MigrationStatusRequestInput,
  SourceScanMigrationStatusRequestInput,
} from "./domain/status.ts";

export {
  DuplicateMigrationDefinitionId,
  ExecutableMigrationDefinitionRegistry,
  MigrationDefinitionDuplicateRequestedDefinitionIgnored,
  MigrationDefinitionDuplicateSourceIdentityTargetIgnored,
  MigrationDefinitionOptionalDependencyCycleIgnored,
  MigrationDefinitionPlanNotice,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryConstructionError,
  MigrationDefinitionRegistryConstructionIssue,
  MigrationDefinitionRegistryExecutableError,
  MigrationDefinitionRegistryInvalidSelectionError,
  MigrationDefinitionRegistryLookupError,
  MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError,
  MigrationDefinitionRegistryUnknownDefinitionError,
  MissingRequiredMigrationDefinitionDependency,
  RequiredMigrationDefinitionDependencyCycle,
} from "./domain/registry.ts";
export type {
  MigrationDefinitionDependencyEdge,
  MigrationDefinitionExecutableRollbackPlan,
  MigrationDefinitionExecutableRunPlan,
  MigrationDefinitionMissingRequirements,
  MigrationDefinitionPlanTarget,
  MigrationDefinitionRegistryEntry,
  MigrationDefinitionRegistryInput,
  MigrationDefinitionRegistryPlanningError,
  MigrationDefinitionRegistryRollbackError,
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryDurableStatusInput,
  MigrationDefinitionRegistryRunError,
  MigrationDefinitionRegistryRunInput,
  MigrationDefinitionRegistrySelectionInput,
  MigrationDefinitionRegistrySourceScanStatusInput,
  MigrationDefinitionRegistryStatusError,
  MigrationDefinitionRegistryStatusInput,
  MigrationDefinitionRegistryStatusReport,
  MigrationDefinitionRollbackPlan,
  MigrationDefinitionRunPlan,
  MigrationRuntimeRequirement,
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
  RollbackMigrationOptionsInput,
  RollbackPipeline,
  RollbackRequest,
  RollbackRequestInput,
} from "./domain/rollback.ts";

export type { RunModeInput } from "./domain/run-mode.ts";

export type {
  SourceItem,
  SourceItemInput,
  SourceItemTotalInput,
  SourceItemTotalLowerBoundReason,
  SourceItemTotalUnknownReason,
  SourceLookupStrategy,
  SourceReadResult,
} from "./domain/source.ts";
export { makeSourceItem, SourceItemTotal } from "./domain/source.ts";

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
  DestinationJournalDiagnosticEntry,
  DestinationJournalDiagnosticInput,
  DestinationJournalDiagnosticSeverity,
  DestinationJournalEntry,
  DestinationJournalRollbackAttemptError,
  DestinationJournalSegment,
  DestinationRollbackAttemptJournalSegment,
  TrackingRecord,
  TrackingRecordContract,
} from "./domain/tracking.ts";
export type {
  DestinationChangeDescriptor as DestinationChangeDescriptorType,
  DestinationChangeValue,
  DestinationJournalChangeEntry as DestinationJournalChangeEntryType,
  DestinationJournalDiagnosticEntry as DestinationJournalDiagnosticEntryType,
  DestinationJournalDiagnosticInput as DestinationJournalDiagnosticInputType,
  DestinationJournalDiagnosticSeverity as DestinationJournalDiagnosticSeverityType,
  DestinationJournalEntry as DestinationJournalEntryType,
  DestinationJournalRollbackAttemptError as DestinationJournalRollbackAttemptErrorType,
  DestinationJournalSegment as DestinationJournalSegmentType,
  DestinationRollbackAttemptJournalSegment as DestinationRollbackAttemptJournalSegmentType,
  TrackingRecordContract as TrackingRecordContractType,
  TrackingRecordContractInput,
  TrackingRecordValue,
} from "./domain/tracking.ts";

export { MigrationReferenceLookup } from "./services/migration-reference-lookup.ts";
export type {
  MigrationReference,
  MigrationReferenceForDefinition,
  MigrationReferenceLookupInput,
  MigrationReferenceLookupTarget,
} from "./services/migration-reference-lookup.ts";
export { MigrationExecutable } from "./services/migration-executable.ts";
export type {
  MigrationExecutableRollbackError,
  MigrationExecutableRunError,
  MigrationExecutableService,
} from "./services/migration-executable.ts";
export { MigrationStore } from "./services/migration-store.ts";
export { MigrationProgress } from "./services/migration-progress.ts";
export { RollbackProgress } from "./services/rollback-progress.ts";
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

export { InMemoryDestination } from "./destinations/in-memory/in-memory-destination.ts";
export type {
  InMemoryEntryDestinationModule,
  InMemoryEntryDestinationModuleOptions,
  InMemoryEntryFieldSchema,
  InMemoryDestinationTransientFailures,
  InMemoryEntryUpsertedChange,
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
  SqlSourceCount,
  SqlSourceCountEffect,
  SqlSourceCountStatement,
  SqlSourceEffectCount,
  SqlSourceLookup,
  SqlSourceMetadata,
  SqlSourceMetadataContext,
  SqlSourceMetadataFailure,
  SqlSourceMetadataResult,
  SqlSourceMetadataSuccess,
  SqlSourceOptions,
  SqlSourceRead,
  SqlSourceStatementCount,
} from "./sources/sql/sql-source.ts";

export { InMemoryMigrationStore } from "./stores/in-memory/in-memory-migration-store.ts";
export type { InMemoryMigrationStoreState } from "./stores/in-memory/in-memory-migration-store.ts";

export {
  FileMigrationStore,
  FileMigrationStorePlatform,
} from "./stores/file/file-migration-store.ts";
export type { FileMigrationStoreOptions } from "./stores/file/file-migration-store.ts";
