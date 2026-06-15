import { Schema } from "effect";
import {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentitySnapshot,
  SourceVersion,
} from "./ids.ts";

const MigrationItemStateBaseFields = {
  definitionId: MigrationDefinitionId,
  lastRunId: MigrationRunId,
  sourceIdentity: SourceIdentitySnapshot,
  updatedAt: Schema.Date,
} as const;

const ObservedSourceVersionFields = {
  sourceVersion: SourceVersion,
} as const;

export const MigrationItemErrorKind = Schema.Literals([
  "source",
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
  destinationIdentity: DestinationIdentity,
  destinationVersion: Schema.optional(DestinationVersion),
  status: Schema.Literal("migrated"),
});
export type MigratedItemState = typeof MigratedItemState.Type;

export const SkippedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  ...ObservedSourceVersionFields,
  skipReason: Schema.String,
  status: Schema.Literal("skipped"),
});
export type SkippedItemState = typeof SkippedItemState.Type;

export const FailedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  sourceVersion: Schema.optional(SourceVersion),
  destinationIdentity: Schema.optional(DestinationIdentity),
  destinationVersion: Schema.optional(DestinationVersion),
  error: MigrationItemError,
  status: Schema.Literal("failed"),
});
export type FailedItemState = typeof FailedItemState.Type;

export const NeedsUpdateItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  sourceVersion: Schema.optional(SourceVersion),
  destinationIdentity: DestinationIdentity,
  destinationVersion: Schema.optional(DestinationVersion),
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
  readonly updatedAt: Date;
}

export type MigrationItemOutcome =
  | "migrated"
  | "skipped"
  | "failed"
  | "needs-update"
  | "unchanged";
