import { type Effect, Schema } from "effect";
import type { Tracking } from "../services/tracking.ts";
import type {
  MigrationDefinition,
  MigrationDefinitionForRuntime,
} from "./definition.ts";
import { RollbackRequestError } from "./errors.ts";
import type {
  MigrationExecutionOptions,
  NormalizedMigrationExecutionOptions,
} from "./execution.ts";
import { normalizeMigrationExecutionOptions } from "./execution.ts";
import type {
  MigrationDefinitionIdInput,
  SourceIdentitySnapshotKey,
} from "./ids.ts";
import {
  MigrationDefinitionId,
  MigrationRunId,
  toMigrationDefinitionId,
} from "./ids.ts";
import type { MigrationItemState } from "./state.ts";

export interface RollbackContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}

export const RollbackContext = Schema.Struct({
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
});

export type RollbackPipeline<
  RollbackError = never,
  ItemState extends MigrationItemState = MigrationItemState,
> = (
  state: ItemState,
  context: RollbackContext
) => void | Effect.Effect<void, RollbackError, Tracking>;

export type AnyRollbackMigrationDefinition =
  MigrationDefinitionForRuntime<
  // biome-ignore lint/suspicious/noExplicitAny: Source is existential across heterogeneous rollback requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Forward process error is not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Cursor is existential across heterogeneous rollback requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source identity key is existential across heterogeneous rollback requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Rollback process error is re-extracted by callers when execution exists.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source input is not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source layer error is not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source requirements are not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Tracking contract is existential across heterogeneous rollback requests.
  any
>;

export type MigrationDefinitionRollbackPipelineError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _PipelineError,
    infer _Cursor,
    infer _IdentityKey,
    infer RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements,
    infer _TrackingContract
  >
    ? RollbackPipelineError
    : Definition extends MigrationDefinitionForRuntime<
          infer _Source,
          infer _PipelineError,
          infer _Cursor,
          infer _IdentityKey,
          infer RollbackPipelineError,
          infer _SourceInput,
          infer _SourceLayerError,
          infer _SourceRequirements,
          infer _TrackingContract
        >
      ? RollbackPipelineError
      : never;

export type RollbackMigrationDefinitionSourceIdentityKey<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _PipelineError,
    infer _Cursor,
    infer IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements,
    infer _TrackingContract
  >
    ? IdentityKey
    : Definition extends MigrationDefinitionForRuntime<
          infer _Source,
          infer _PipelineError,
          infer _Cursor,
          infer IdentityKey,
          infer _RollbackPipelineError,
          infer _SourceInput,
          infer _SourceLayerError,
          infer _SourceRequirements,
          infer _TrackingContract
        >
      ? IdentityKey
      : never;

export interface RollbackRequest<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly execution?: NormalizedMigrationExecutionOptions;
  readonly sourceIdentityKeys?: readonly [
    RollbackMigrationDefinitionSourceIdentityKey<Definitions[number]>,
    ...RollbackMigrationDefinitionSourceIdentityKey<Definitions[number]>[],
  ];
}

export interface RollbackRequestInput<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly execution?: MigrationExecutionOptions;
  readonly sourceIdentityKeys?: readonly RollbackMigrationDefinitionSourceIdentityKey<
    Definitions[number]
  >[];
}

export const makeRollbackRequest = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: RollbackRequestInput<Definitions>
): RollbackRequest<Definitions> => {
  const options = makeRollbackMigrationOptions(
    input.sourceIdentityKeys === undefined
      ? {}
      : { sourceIdentityKeys: input.sourceIdentityKeys }
  );

  return {
    definitions: input.definitions,
    ...(input.definitionIds === undefined
      ? {}
      : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
    ...(input.execution === undefined
      ? {}
      : { execution: normalizeMigrationExecutionOptions(input.execution) }),
    ...(options.sourceIdentityKeys === undefined
      ? {}
      : { sourceIdentityKeys: options.sourceIdentityKeys }),
  };
};

export interface RollbackMigrationOptions<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly execution?: NormalizedMigrationExecutionOptions;
  readonly sourceIdentityKeys?: readonly [IdentityKey, ...IdentityKey[]];
}

export const RollbackMigrationOptions = Schema.Struct({
  sourceIdentityKeys: Schema.optional(
    Schema.TupleWithRest(Schema.Tuple([Schema.Unknown]), [Schema.Unknown])
  ),
});

export interface RollbackMigrationOptionsInput<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly execution?: MigrationExecutionOptions;
  readonly sourceIdentityKeys?: readonly IdentityKey[];
}

export const makeRollbackMigrationOptions = <
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  input: RollbackMigrationOptionsInput<IdentityKey> = {}
): RollbackMigrationOptions<IdentityKey> => {
  if (
    input.sourceIdentityKeys !== undefined &&
    input.sourceIdentityKeys.length === 0
  ) {
    throw new RollbackRequestError({
      message: "Rollback sourceIdentityKeys must include at least one identity",
    });
  }

  if (input.sourceIdentityKeys === undefined) {
    return {
      ...(input.execution === undefined
        ? {}
        : { execution: normalizeMigrationExecutionOptions(input.execution) }),
    };
  }

  const [firstKey, ...remainingKeys] = input.sourceIdentityKeys;

  if (firstKey === undefined) {
    throw new RollbackRequestError({
      message: "Rollback sourceIdentityKeys must include at least one identity",
    });
  }

  return {
    ...(input.execution === undefined
      ? {}
      : { execution: normalizeMigrationExecutionOptions(input.execution) }),
    sourceIdentityKeys: [firstKey, ...remainingKeys],
  };
};

const RollbackSummaryCount = Schema.Number.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0)
);

export interface RollbackDefinitionRunSummary {
  readonly counts: {
    readonly rolledBack: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed";
}

export const RollbackDefinitionRunSummary = Schema.Struct({
  counts: Schema.Struct({
    rolledBack: RollbackSummaryCount,
    failed: RollbackSummaryCount,
    skipped: RollbackSummaryCount,
  }),
  definitionId: MigrationDefinitionId,
  status: Schema.Literals(["succeeded", "failed"]),
});

export interface RollbackRunSummary {
  readonly definitions: readonly RollbackDefinitionRunSummary[];
  readonly finishedAt: Date;
  readonly kind: "rollback";
  readonly runId: MigrationRunId;
  readonly startedAt: Date;
  readonly status: "succeeded" | "failed";
}

export const RollbackRunSummary = Schema.Struct({
  kind: Schema.Literal("rollback"),
  definitions: Schema.Array(RollbackDefinitionRunSummary),
  finishedAt: Schema.Date,
  runId: MigrationRunId,
  startedAt: Schema.Date,
  status: Schema.Literals(["succeeded", "failed"]),
});
