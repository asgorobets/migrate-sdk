import { Schema } from "effect";
import {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
  SourceVersion,
} from "./ids.ts";

const MigrationItemStateBaseFields = {
  definitionId: MigrationDefinitionId,
  lastRunId: MigrationRunId,
  sourceIdentity: SourceIdentity,
  sourceVersion: Schema.optional(SourceVersion),
  updatedAt: Schema.Date,
} as const;

export const MigrationItemErrorKind = Schema.Literals([
  "source",
  "pipeline",
  "destination",
]);
export type MigrationItemErrorKind = typeof MigrationItemErrorKind.Type;

export const MigrationItemError = Schema.Struct({
  kind: MigrationItemErrorKind,
  errorTag: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
});
export type MigrationItemError = typeof MigrationItemError.Type;

export const MigratedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  destinationIdentity: DestinationIdentity,
  destinationVersion: Schema.optional(DestinationVersion),
  status: Schema.Literal("migrated"),
});
export type MigratedItemState = typeof MigratedItemState.Type;

export const SkippedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  skipReason: Schema.String,
  status: Schema.Literal("skipped"),
});
export type SkippedItemState = typeof SkippedItemState.Type;

export const FailedItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
  destinationIdentity: Schema.optional(DestinationIdentity),
  destinationVersion: Schema.optional(DestinationVersion),
  error: MigrationItemError,
  status: Schema.Literal("failed"),
});
export type FailedItemState = typeof FailedItemState.Type;

export const NeedsUpdateItemState = Schema.Struct({
  ...MigrationItemStateBaseFields,
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
  readonly sourceIdentity: SourceIdentity;
  readonly sourceVersion?: SourceVersion;
  readonly updatedAt: Date;
}

export type MigrationItemOutcome =
  | "migrated"
  | "skipped"
  | "failed"
  | "needs-update"
  | "unchanged";
