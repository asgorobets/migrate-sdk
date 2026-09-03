import { Schema } from "effect";
import {
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentitySnapshot,
  SourceVersion,
} from "../../domain/ids.ts";
import { SourceVersionContractFingerprint } from "../../domain/migration-contract.ts";
import { MigrationItemError } from "../../domain/state.ts";
import {
  DestinationJournalEntry,
  DestinationJournalExtensions,
  DestinationJournalRollbackAttemptError,
  TrackingRecord,
} from "../../domain/tracking.ts";

const PersistedMigrationItemStateBaseFields = {
  definitionId: MigrationDefinitionId,
  lastRunId: MigrationRunId,
  lastSourceInventoryRunId: Schema.optional(MigrationRunId),
  sourceIdentity: SourceIdentitySnapshot,
  updatedAt: Schema.DateFromString,
} as const;

const PersistedObservedSourceVersionFields = {
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: SourceVersion,
} as const;

const PersistedDestinationJournalSegmentFields = {
  entries: Schema.Array(DestinationJournalEntry),
  runId: MigrationRunId,
} as const;

const PersistedDestinationJournalSegment = Schema.Struct(
  PersistedDestinationJournalSegmentFields
);

const PersistedDestinationRollbackAttemptJournalSegment = Schema.Struct({
  ...PersistedDestinationJournalSegmentFields,
  error: DestinationJournalRollbackAttemptError,
  failedAt: Schema.DateFromString,
});

const PersistedDestinationJournal = Schema.Struct({
  extensions: Schema.optional(DestinationJournalExtensions),
  process: PersistedDestinationJournalSegment,
  rollbackAttempts: Schema.Array(
    PersistedDestinationRollbackAttemptJournalSegment
  ),
});

const PersistedMigratedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  ...PersistedObservedSourceVersionFields,
  journal: Schema.optional(PersistedDestinationJournal),
  status: Schema.Literal("migrated"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedSkippedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  ...PersistedObservedSourceVersionFields,
  journal: Schema.optional(PersistedDestinationJournal),
  skipReason: Schema.String,
  status: Schema.Literal("skipped"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedFailedItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersion),
  error: MigrationItemError,
  journal: Schema.optional(PersistedDestinationJournal),
  status: Schema.Literal("failed"),
  trackingRecord: Schema.optional(TrackingRecord),
});

const PersistedNeedsUpdateItemState = Schema.Struct({
  ...PersistedMigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersion),
  journal: Schema.optional(PersistedDestinationJournal),
  reason: Schema.String,
  status: Schema.Literal("needs-update"),
  trackingRecord: Schema.optional(TrackingRecord),
});

export const PersistedMigrationItemState = Schema.Union([
  PersistedMigratedItemState,
  PersistedSkippedItemState,
  PersistedFailedItemState,
  PersistedNeedsUpdateItemState,
]);
