// biome-ignore-all assist/source/organizeImports: Public SDK entrypoint is grouped by domain for readability.
// biome-ignore-all lint/performance/noBarrelFile: Public package entrypoint intentionally re-exports the SDK surface.

export type {
  ConfiguredSource,
  MigrationDefinitionDependencies,
  MigrationDefinitionDependenciesInput,
  MigrationDefinitionInput,
  SourcePayloadSchema,
  SourceFactoryInput,
  SourceImplementation,
  SourceMakeInput,
  SourceReadResultInput,
  SourceRetryStrategy,
} from "./domain/definition.ts";
export {
  MigrationDefinition,
  Source,
} from "./domain/definition.ts";

export {
  DestinationError,
  makeSkipItem,
  MigrationReferenceLookupError,
  MigrationRuntimeError,
  MigrationStoreError,
  RollbackPreflightError,
  RollbackRequestError,
  skipItem,
  SkipItem,
  SourceError,
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
  MigrationDefinitionRegistryIdInput,
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
  MigrationDefinitionRegistryId,
  MigrationDefinitionLockToken,
  MigrationRunId,
  SourceIdentity,
  SourceIdentitySnapshot as SourceIdentitySnapshotSchema,
  SourceVersion,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionRegistryId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toEncodedSourceIdentity,
  toSourceVersion,
} from "./domain/ids.ts";

export {
  executeMigrationExecutionEnvelope,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
  MigrationExecutionEnvelope,
  MigrationExecutionEnvelopeMissingRegistryIdError,
  MigrationRollbackExecutionEnvelope,
  MigrationRunExecutionEnvelope,
} from "./domain/execution-envelope.ts";
export type {
  MigrationExecutionEnvelope as MigrationExecutionEnvelopeType,
  MigrationExecutionEnvelopeBase,
  MigrationExecutionEnvelopeExecutionError,
  MigrationExecutionEnvelopeInput,
  MigrationRollbackExecutionEnvelope as MigrationRollbackExecutionEnvelopeType,
  MigrationRunExecutionEnvelope as MigrationRunExecutionEnvelopeType,
} from "./domain/execution-envelope.ts";

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
  MigrationDefinitionRegistryRollbackInput,
  MigrationDefinitionRegistryDurableStatusInput,
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
  RollbackContext,
  RollbackDefinitionRunSummary,
  RollbackRunSummary,
} from "./domain/rollback.ts";
export type {
  AnyRollbackMigrationDefinition,
  MigrationDefinitionRollbackPipelineError,
  RollbackPipeline,
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
  MigrationExecutableAdapterError,
  MigrationExecutableInlineRollbackStartError,
  MigrationExecutableInlineRunStartError,
  MigrationExecutableRollbackError,
  MigrationExecutableRollbackStartError,
  MigrationExecutableRunError,
  MigrationExecutableRunStartError,
  MigrationExecutableService,
} from "./services/migration-executable.ts";
export { MigrationExecution } from "./services/migration-execution.ts";
export { validateMigrationRunDependencyPreflight } from "./services/migration-run-executor.ts";
export type {
  BoundMigrationExecutionService,
  MigrationExecutionMakeInput,
  MigrationExecutionRollbackError,
  MigrationExecutionRollbackInput,
  MigrationExecutionRunError,
  MigrationExecutionRunInput,
  MigrationExecutionService,
} from "./services/migration-execution.ts";
export {
  DuplicateMigrationDefinitionRegistryId,
  MigrationDefinitionRegistryCatalog,
  MigrationDefinitionRegistryCatalogConstructionError,
  MigrationDefinitionRegistryCatalogConstructionIssue,
  MigrationDefinitionRegistryCatalogLookupError,
  MissingMigrationDefinitionRegistryId,
} from "./services/migration-definition-registry-catalog.ts";
export type {
  MigrationDefinitionRegistryCatalogLayerInput,
  MigrationDefinitionRegistryCatalogService,
} from "./services/migration-definition-registry-catalog.ts";
export { MigrationStore } from "./services/migration-store.ts";
export { MigrationProgress } from "./services/migration-progress.ts";
export { RollbackProgress } from "./services/rollback-progress.ts";
export { Tracking } from "./services/tracking.ts";
export type {
  TrackingProcessContext,
  TrackingService,
} from "./services/tracking.ts";

export { InMemoryDestination } from "./destinations/in-memory/in-memory-destination.ts";
export type {
  InMemoryEntryDestinationModule,
  InMemoryEntryDestinationModuleOptions,
  InMemoryEntryFieldSchema,
  InMemoryDestinationTransientFailures,
  InMemoryEntryUpsertedChange,
} from "./destinations/in-memory/in-memory-destination.ts";

export { InMemorySource } from "./sources/in-memory/in-memory-source.ts";
export { InMemorySourceCursor } from "./sources/in-memory/in-memory-source.ts";
export type {
  InMemorySourceOptions,
  InMemorySourceState,
  InMemorySourceTransientFailures,
} from "./sources/in-memory/in-memory-source.ts";

export {
  CsvIdentity,
  CsvSourceCursor,
  CsvSource,
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
  SqlSource,
  SqlSourceName,
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
