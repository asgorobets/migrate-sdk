import { Schema } from "effect";
import {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentitySnapshot,
  SourceVersion,
} from "./ids.ts";
import { SourceVersionContractFingerprint } from "./migration-contract.ts";
import { DestinationJournal } from "./tracking.ts";

const MigrationItemStateBaseFields = {
  definitionId: MigrationDefinitionId,
  lastRunId: MigrationRunId,
  sourceIdentity: SourceIdentitySnapshot,
  updatedAt: Schema.Date,
} as const;

const ObservedSourceVersionFields = {
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: SourceVersion,
} as const;

export const MigrationItemErrorKind = Schema.Literals([
  "source",
  "process",
  "pipeline",
  "destination",
]);
export type MigrationItemErrorKind = typeof MigrationItemErrorKind.Type;

export const MigrationItemErrorDetail = Schema.Struct({
  path: Schema.optional(Schema.String),
  message: Schema.String,
});
export type MigrationItemErrorDetail = typeof MigrationItemErrorDetail.Type;

export const MigrationItemError = Schema.Struct({
  kind: MigrationItemErrorKind,
  errorTag: Schema.String,
  message: Schema.String,
  details: Schema.optional(Schema.Array(MigrationItemErrorDetail)),
});
export type MigrationItemError = typeof MigrationItemError.Type;

export const MigratedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  ...ObservedSourceVersionFields,
  destinationIdentity: Schema.optional(DestinationIdentity),
  destinationVersion: Schema.optional(DestinationVersion),
  journal: Schema.optional(DestinationJournal),
  status: Schema.Literal("migrated"),
});
export type MigratedItemState = typeof MigratedItemState.Type;

export const SkippedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  ...ObservedSourceVersionFields,
  journal: Schema.optional(DestinationJournal),
  skipReason: Schema.String,
  status: Schema.Literal("skipped"),
});
export type SkippedItemState = typeof SkippedItemState.Type;

export const FailedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersion),
  destinationIdentity: Schema.optional(DestinationIdentity),
  destinationVersion: Schema.optional(DestinationVersion),
  error: MigrationItemError,
  journal: Schema.optional(DestinationJournal),
  status: Schema.Literal("failed"),
});
export type FailedItemState = typeof FailedItemState.Type;

export const NeedsUpdateItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  sourceVersionContractFingerprint: Schema.optional(
    SourceVersionContractFingerprint
  ),
  sourceVersion: Schema.optional(SourceVersion),
  destinationIdentity: DestinationIdentity,
  destinationVersion: Schema.optional(DestinationVersion),
  journal: Schema.optional(DestinationJournal),
  reason: Schema.String,
  status: Schema.Literal("needs-update"),
});
export type NeedsUpdateItemState = typeof NeedsUpdateItemState.Type;

export const MigrationItemState = Schema.Union([
  MigratedItemState,
  SkippedItemState,
  FailedItemState,
  NeedsUpdateItemState,
]);
export type MigrationItemState = typeof MigrationItemState.Type;

export interface MigrationItemStateBase {
  readonly definitionId: MigrationDefinitionId;
  readonly lastRunId: MigrationRunId;
  readonly sourceIdentity: SourceIdentitySnapshot;
  readonly sourceVersion?: SourceVersion;
  readonly sourceVersionContractFingerprint?: SourceVersionContractFingerprint;
  readonly updatedAt: Date;
}

export type MigrationItemOutcome =
  | "migrated"
  | "skipped"
  | "failed"
  | "needs-update"
  | "unchanged";
