import { type Effect, Schema } from "effect";
import type { MigrationDefinition } from "./definition.ts";
import type {
  DestinationCommand,
  DestinationCommandPlan,
} from "./destination.ts";
import { RollbackRequestError } from "./errors.ts";
import type {
  DestinationIdentity,
  MigrationDefinitionIdInput,
  SourceIdentityInput,
} from "./ids.ts";
import {
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
  toMigrationDefinitionId,
  toSourceIdentity,
} from "./ids.ts";
import type {
  FailedItemState,
  MigratedItemState,
  NeedsUpdateItemState,
} from "./state.ts";

export type RollbackableMigrationItemState =
  | MigratedItemState
  | NeedsUpdateItemState
  | (FailedItemState & {
      readonly destinationIdentity: DestinationIdentity;
    });

export interface RollbackContext {
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}

export const RollbackContext = Schema.Struct({
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
});

export type RollbackPipeline<
  Command extends DestinationCommand,
  RollbackError = never,
> = (
  state: RollbackableMigrationItemState,
  context: RollbackContext
) =>
  | DestinationCommandPlan<Command>
  | Effect.Effect<DestinationCommandPlan<Command>, RollbackError>;

export type AnyRollbackMigrationDefinition = MigrationDefinition<
  // biome-ignore lint/suspicious/noExplicitAny: Source is existential across heterogeneous rollback requests.
  any,
  DestinationCommand,
  // biome-ignore lint/suspicious/noExplicitAny: Forward pipeline error is not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Cursor is existential across heterogeneous rollback requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Rollback pipeline error is re-extracted by callers when execution exists.
  any
>;

export type MigrationDefinitionRollbackPipelineError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _Command,
    infer _PipelineError,
    infer _Cursor,
    infer RollbackPipelineError
  >
    ? RollbackPipelineError
    : never;

export interface RollbackRequest<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly sourceIdentities?: readonly [SourceIdentity, ...SourceIdentity[]];
}

export interface RollbackRequestInput<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly sourceIdentities?: readonly SourceIdentityInput[];
}

export const makeRollbackRequest = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: RollbackRequestInput<Definitions>
): RollbackRequest<Definitions> => {
  const options = makeRollbackMigrationOptions(
    input.sourceIdentities === undefined
      ? {}
      : { sourceIdentities: input.sourceIdentities }
  );

  return {
    definitions: input.definitions,
    ...(input.definitionIds === undefined
      ? {}
      : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
    ...(options.sourceIdentities === undefined
      ? {}
      : { sourceIdentities: options.sourceIdentities }),
  };
};

export interface RollbackMigrationOptions {
  readonly sourceIdentities?: readonly [SourceIdentity, ...SourceIdentity[]];
}

export const RollbackMigrationOptions = Schema.Struct({
  sourceIdentities: Schema.optional(
    Schema.TupleWithRest(Schema.Tuple([SourceIdentity]), [SourceIdentity])
  ),
});

export interface RollbackMigrationOptionsInput {
  readonly sourceIdentities?: readonly SourceIdentityInput[];
}

export const makeRollbackMigrationOptions = (
  input: RollbackMigrationOptionsInput = {}
): RollbackMigrationOptions => {
  if (
    input.sourceIdentities !== undefined &&
    input.sourceIdentities.length === 0
  ) {
    throw new RollbackRequestError({
      message: "Rollback sourceIdentities must include at least one identity",
    });
  }

  if (input.sourceIdentities === undefined) {
    return {};
  }

  const sourceIdentities: SourceIdentity[] = [];
  const seenSourceIdentities = new Set<SourceIdentity>();

  for (const sourceIdentityInput of input.sourceIdentities) {
    const sourceIdentity = toSourceIdentity(sourceIdentityInput);

    if (seenSourceIdentities.has(sourceIdentity)) {
      continue;
    }

    seenSourceIdentities.add(sourceIdentity);
    sourceIdentities.push(sourceIdentity);
  }

  const [firstIdentity, ...remainingIdentities] = sourceIdentities;

  if (firstIdentity === undefined) {
    throw new RollbackRequestError({
      message: "Rollback sourceIdentities must include at least one identity",
    });
  }

  return {
    sourceIdentities: [firstIdentity, ...remainingIdentities],
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
