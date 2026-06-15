import { type Effect, Schema } from "effect";
import type { MigrationDefinition } from "./definition.ts";
import type {
  DestinationCommand,
  DestinationCommandPlan,
} from "./destination.ts";
import { RollbackRequestError } from "./errors.ts";
import type {
  DestinationIdentity,
  EncodedSourceIdentity,
  EncodedSourceIdentityInput,
  MigrationDefinitionIdInput,
  SourceIdentitySnapshotKey,
} from "./ids.ts";
import {
  MigrationDefinitionId,
  MigrationRunId,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
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
  // biome-ignore lint/suspicious/noExplicitAny: Source identity key is existential across heterogeneous rollback requests.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Rollback pipeline error is re-extracted by callers when execution exists.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source input is not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source layer error is not relevant to rollback request shape.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Source requirements are not relevant to rollback request shape.
  any
>;

export type MigrationDefinitionRollbackPipelineError<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _Command,
    infer _PipelineError,
    infer _Cursor,
    infer _IdentityKey,
    infer RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements
  >
    ? RollbackPipelineError
    : never;

export type RollbackMigrationDefinitionSourceIdentityKey<Definition> =
  Definition extends MigrationDefinition<
    infer _Source,
    infer _Command,
    infer _PipelineError,
    infer _Cursor,
    infer IdentityKey,
    infer _RollbackPipelineError,
    infer _SourceInput,
    infer _SourceLayerError,
    infer _SourceRequirements
  >
    ? IdentityKey
    : never;

export interface RollbackRequest<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
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
    ...(options.sourceIdentityKeys === undefined
      ? {}
      : { sourceIdentityKeys: options.sourceIdentityKeys }),
  };
};

export interface RollbackMigrationOptions<
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
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
    return {};
  }

  const [firstKey, ...remainingKeys] = input.sourceIdentityKeys;

  if (firstKey === undefined) {
    throw new RollbackRequestError({
      message: "Rollback sourceIdentityKeys must include at least one identity",
    });
  }

  return {
    sourceIdentityKeys: [firstKey, ...remainingKeys],
  };
};

export interface EncodedRollbackRequest<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionId[];
  readonly definitions: Definitions;
  readonly encodedSourceIdentities?: readonly [
    EncodedSourceIdentity,
    ...EncodedSourceIdentity[],
  ];
}

export interface EncodedRollbackRequestInput<
  Definitions extends
    readonly AnyRollbackMigrationDefinition[] = readonly AnyRollbackMigrationDefinition[],
> {
  readonly definitionIds?: readonly MigrationDefinitionIdInput[];
  readonly definitions: Definitions;
  readonly encodedSourceIdentities?: readonly EncodedSourceIdentityInput[];
}

export interface EncodedRollbackMigrationOptions {
  readonly encodedSourceIdentities?: readonly [
    EncodedSourceIdentity,
    ...EncodedSourceIdentity[],
  ];
}

export interface EncodedRollbackMigrationOptionsInput {
  readonly encodedSourceIdentities?: readonly EncodedSourceIdentityInput[];
}

export const makeEncodedRollbackMigrationOptions = (
  input: EncodedRollbackMigrationOptionsInput = {}
): EncodedRollbackMigrationOptions => {
  if (
    input.encodedSourceIdentities !== undefined &&
    input.encodedSourceIdentities.length === 0
  ) {
    throw new RollbackRequestError({
      message:
        "Rollback encodedSourceIdentities must include at least one identity",
    });
  }

  if (input.encodedSourceIdentities === undefined) {
    return {};
  }

  const sourceIdentities: EncodedSourceIdentity[] = [];
  const seenSourceIdentities = new Set<EncodedSourceIdentity>();

  for (const sourceIdentityInput of input.encodedSourceIdentities) {
    const sourceIdentity = toEncodedSourceIdentity(sourceIdentityInput);

    if (seenSourceIdentities.has(sourceIdentity)) {
      continue;
    }

    seenSourceIdentities.add(sourceIdentity);
    sourceIdentities.push(sourceIdentity);
  }

  const [firstIdentity, ...remainingIdentities] = sourceIdentities;

  if (firstIdentity === undefined) {
    throw new RollbackRequestError({
      message:
        "Rollback encodedSourceIdentities must include at least one identity",
    });
  }

  return {
    encodedSourceIdentities: [firstIdentity, ...remainingIdentities],
  };
};

export const makeEncodedRollbackRequest = <
  Definitions extends readonly AnyRollbackMigrationDefinition[],
>(
  input: EncodedRollbackRequestInput<Definitions>
): EncodedRollbackRequest<Definitions> => {
  const options = makeEncodedRollbackMigrationOptions(
    input.encodedSourceIdentities === undefined
      ? {}
      : { encodedSourceIdentities: input.encodedSourceIdentities }
  );

  return {
    definitions: input.definitions,
    ...(input.definitionIds === undefined
      ? {}
      : { definitionIds: input.definitionIds.map(toMigrationDefinitionId) }),
    ...(options.encodedSourceIdentities === undefined
      ? {}
      : { encodedSourceIdentities: options.encodedSourceIdentities }),
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
