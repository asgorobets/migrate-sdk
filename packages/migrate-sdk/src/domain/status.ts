import { Schema } from "effect";
import type { MigrationStoreError, SourceError } from "./errors.ts";
import type {
  MigrationDefinitionId,
  MigrationDefinitionIdInput,
} from "./ids.ts";
import {
  EncodedSourceIdentity,
  MigrationDefinitionId as MigrationDefinitionIdSchema,
  SourceIdentityKeyScalar,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { AnyMigrationDefinition } from "./run.ts";
import { MigrationRunState } from "./run.ts";
import { MigrationItemErrorDetail, type MigrationItemState } from "./state.ts";

const StatusCount = Schema.Number.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0)
);

export const MigrationItemStateSummary = Schema.Struct({
  migrated: StatusCount,
  skipped: StatusCount,
  failed: StatusCount,
  needsUpdate: StatusCount,
});
export type MigrationItemStateSummary = typeof MigrationItemStateSummary.Type;

export const MigrationDefinitionSourceStatus = Schema.Struct({
  total: StatusCount,
  unprocessed: StatusCount,
  invalid: StatusCount,
  duplicate: StatusCount,
  orphaned: StatusCount,
});
export type MigrationDefinitionSourceStatus =
  typeof MigrationDefinitionSourceStatus.Type;

export const SourceIdentityStatusPart = Schema.Struct({
  name: Schema.NonEmptyString,
  value: SourceIdentityKeyScalar,
});
export type SourceIdentityStatusPart = typeof SourceIdentityStatusPart.Type;

export class DuplicateSourceIdentityStatusWarning extends Schema.TaggedClass<DuplicateSourceIdentityStatusWarning>()(
  "DuplicateSourceIdentityStatusWarning",
  {
    count: StatusCount,
    definitionId: MigrationDefinitionIdSchema,
    sourceIdentity: EncodedSourceIdentity,
    sourceIdentityParts: Schema.optional(
      Schema.Array(SourceIdentityStatusPart)
    ),
  }
) {}

export class InvalidSourceItemStatusWarning extends Schema.TaggedClass<InvalidSourceItemStatusWarning>()(
  "InvalidSourceItemStatusWarning",
  {
    definitionId: MigrationDefinitionIdSchema,
    details: Schema.optional(Schema.Array(MigrationItemErrorDetail)),
    message: Schema.String,
    sourceIdentity: EncodedSourceIdentity,
  }
) {}

export const MigrationStatusWarning = Schema.Union([
  DuplicateSourceIdentityStatusWarning,
  InvalidSourceItemStatusWarning,
]);
export type MigrationStatusWarning = typeof MigrationStatusWarning.Type;

export const MigrationDefinitionStatus = Schema.Struct({
  definitionId: MigrationDefinitionIdSchema,
  lastRun: Schema.NullOr(MigrationRunState),
  durable: MigrationItemStateSummary,
  source: Schema.optional(MigrationDefinitionSourceStatus),
  warnings: Schema.Array(MigrationStatusWarning),
});
export type MigrationDefinitionStatus = typeof MigrationDefinitionStatus.Type;

export const MigrationStatusReport = Schema.Struct({
  definitions: Schema.Array(MigrationDefinitionStatus),
  scanSource: Schema.Boolean,
  warnings: Schema.Array(MigrationStatusWarning),
});
export type MigrationStatusReport = typeof MigrationStatusReport.Type;

export interface MigrationStatusRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly concurrency?: number;
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly scanSource?: boolean;
}

export type DurableMigrationStatusRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = Omit<
  MigrationStatusRequestInput<Definitions>,
  "concurrency" | "scanSource"
> & {
  readonly concurrency?: never;
  readonly scanSource?: false;
};

export type SourceScanMigrationStatusRequestInput<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> = Omit<MigrationStatusRequestInput<Definitions>, "scanSource"> & {
  readonly scanSource: true;
};

export interface MigrationStatusRequest<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly concurrency: number;
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly scanSource: boolean;
}

export class MigrationStatusRequestError extends Schema.TaggedErrorClass<MigrationStatusRequestError>()(
  "MigrationStatusRequestError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export type GetMigrationStatusesError =
  | MigrationStatusRequestError
  | MigrationStoreError
  | SourceError;

export const emptyMigrationItemStateSummary =
  (): MigrationItemStateSummary => ({
    migrated: 0,
    skipped: 0,
    failed: 0,
    needsUpdate: 0,
  });

export const summarizeMigrationItemStates = (
  itemStates: readonly MigrationItemState[]
): MigrationItemStateSummary => {
  const summary = {
    migrated: 0,
    skipped: 0,
    failed: 0,
    needsUpdate: 0,
  };

  for (const itemState of itemStates) {
    switch (itemState.status) {
      case "migrated":
        summary.migrated += 1;
        break;
      case "skipped":
        summary.skipped += 1;
        break;
      case "failed":
        summary.failed += 1;
        break;
      case "needs-update":
        summary.needsUpdate += 1;
        break;
      default:
        break;
    }
  }

  return summary;
};

const invalidConcurrencyError = (concurrency: number) =>
  new MigrationStatusRequestError({
    message: "Status concurrency must be a positive integer",
    cause: { concurrency },
  });

export const makeMigrationStatusRequest = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: MigrationStatusRequestInput<Definitions>
): MigrationStatusRequest<Definitions> => {
  const scanSource = input.scanSource ?? false;
  const concurrency = input.concurrency ?? 1;

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw invalidConcurrencyError(concurrency);
  }

  if (!scanSource && input.concurrency !== undefined) {
    throw new MigrationStatusRequestError({
      message:
        "Status concurrency is only valid when source scanning is enabled",
      cause: { concurrency },
    });
  }

  return {
    definitions: input.definitions,
    ...(input.definitionIds === undefined
      ? {}
      : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
    scanSource,
    concurrency,
  };
};
