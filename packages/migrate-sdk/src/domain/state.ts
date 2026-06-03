import type {
  DestinationIdentity,
  DestinationVersion,
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
  SourceVersion,
} from "./ids.ts";

export interface MigrationItemStateBase {
  readonly definitionId: MigrationDefinitionId;
  readonly sourceIdentity: SourceIdentity;
  readonly sourceVersion?: SourceVersion;
  readonly lastRunId: MigrationRunId;
  readonly updatedAt: Date;
}

export interface MigratedItemState extends MigrationItemStateBase {
  readonly status: "migrated";
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
}

export interface SkippedItemState extends MigrationItemStateBase {
  readonly status: "skipped";
  readonly skipReason: string;
}

export interface FailedItemState extends MigrationItemStateBase {
  readonly status: "failed";
  readonly error: MigrationItemError;
  readonly destinationIdentity?: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
}

export interface NeedsUpdateItemState extends MigrationItemStateBase {
  readonly status: "needs-update";
  readonly destinationIdentity: DestinationIdentity;
  readonly destinationVersion?: DestinationVersion;
  readonly reason: string;
}

export type MigrationItemState =
  | MigratedItemState
  | SkippedItemState
  | FailedItemState
  | NeedsUpdateItemState;

export interface MigrationItemError {
  readonly kind: "source" | "pipeline" | "destination";
  readonly tag: string;
  readonly message: string;
  readonly data?: unknown;
}

export type MigrationItemOutcome =
  | "migrated"
  | "skipped"
  | "failed"
  | "needs-update"
  | "unchanged";

