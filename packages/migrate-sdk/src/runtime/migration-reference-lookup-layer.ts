import { Effect, Layer } from "effect";
import {
  type DestinationPluginError,
  MigrationReferenceLookupError,
  type MigrationStoreError,
} from "../domain/errors.ts";
import type { MigrationDefinitionId, SourceIdentity } from "../domain/ids.ts";
import { toMigrationDefinitionId, toSourceIdentity } from "../domain/ids.ts";
import type { AnyMigrationDefinition } from "../domain/run.ts";
import type { MigrationItemState } from "../domain/state.ts";
import {
  type MigrationReference,
  MigrationReferenceLookup,
  type MigrationReferenceLookupInput,
} from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";

export type CreateMigrationReferenceStub = (input: {
  readonly definition: AnyMigrationDefinition;
  readonly sourceIdentity: SourceIdentity;
}) => Effect.Effect<
  MigrationReference,
  DestinationPluginError | MigrationReferenceLookupError | MigrationStoreError
>;

const definitionNotFoundError = (definitionId: MigrationDefinitionId) =>
  new MigrationReferenceLookupError({
    message: "Migration Reference Lookup definition was not found",
    cause: { definitionId },
  });

const stubDefinitionNotInLookupError = (
  definitionId: MigrationDefinitionId,
  definitionIds: readonly MigrationDefinitionId[]
) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Reference Lookup stub definition must be one of the lookup definitions",
    cause: { definitionId, definitionIds },
  });

const definitionIdsFromInput = (
  input: MigrationReferenceLookupInput
): readonly MigrationDefinitionId[] =>
  "definitionIds" in input && input.definitionIds !== undefined
    ? input.definitionIds.map(toMigrationDefinitionId)
    : [toMigrationDefinitionId(input.definitionId)];

const sourceIdentityFromInput = (
  input: MigrationReferenceLookupInput
): SourceIdentity => toSourceIdentity(input.sourceIdentity);

const stubDefinitionIdFromInput = (
  input: MigrationReferenceLookupInput,
  definitionIds: readonly MigrationDefinitionId[]
): MigrationDefinitionId | null => {
  if (input.stub !== true && typeof input.stub !== "object") {
    return null;
  }

  if (typeof input.stub === "object" && input.stub.definitionId !== undefined) {
    return toMigrationDefinitionId(input.stub.definitionId);
  }

  return definitionIds[0] ?? null;
};

const referenceFromState = (
  state: MigrationItemState | null
): MigrationReference | null =>
  state?.status === "migrated" || state?.status === "needs-update"
    ? {
        definitionId: state.definitionId,
        destinationIdentity: state.destinationIdentity,
        ...(state.destinationVersion === undefined
          ? {}
          : { destinationVersion: state.destinationVersion }),
        sourceIdentity: state.sourceIdentity,
        status: state.status,
      }
    : null;

const getReferenceState = (
  definition: AnyMigrationDefinition,
  sourceIdentity: SourceIdentity
) =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;

    return yield* store.getItemState(definition.id, sourceIdentity);
  }).pipe(Effect.provide(definition.store));

const findExistingReference = (
  definitionsById: ReadonlyMap<MigrationDefinitionId, AnyMigrationDefinition>,
  definitionIds: readonly MigrationDefinitionId[],
  sourceIdentity: SourceIdentity
) =>
  Effect.gen(function* () {
    for (const definitionId of definitionIds) {
      const definition = definitionsById.get(definitionId);

      if (definition === undefined) {
        return yield* definitionNotFoundError(definitionId);
      }

      const state = yield* getReferenceState(definition, sourceIdentity);
      const reference = referenceFromState(state);

      if (reference !== null) {
        return reference;
      }
    }

    return null;
  });

const validateStubDefinitionId = (
  stubDefinitionId: MigrationDefinitionId,
  definitionIds: readonly MigrationDefinitionId[]
) =>
  definitionIds.includes(stubDefinitionId)
    ? Effect.succeed(stubDefinitionId)
    : Effect.fail(
        stubDefinitionNotInLookupError(stubDefinitionId, definitionIds)
      );

export const makeMigrationReferenceLookupLayer = ({
  createStubReference,
  definitions,
}: {
  readonly createStubReference: CreateMigrationReferenceStub;
  readonly definitions: readonly AnyMigrationDefinition[];
}): Layer.Layer<MigrationReferenceLookup> =>
  Layer.effect(
    MigrationReferenceLookup,
    Effect.gen(function* () {
      const definitionsById = new Map(
        definitions.map((definition) => [definition.id, definition])
      );

      const lookup = Effect.fn("MigrationReferenceLookup.lookup")(function* (
        input: MigrationReferenceLookupInput
      ) {
        const definitionIds = definitionIdsFromInput(input);
        const sourceIdentity = sourceIdentityFromInput(input);
        const existingReference = yield* findExistingReference(
          definitionsById,
          definitionIds,
          sourceIdentity
        );

        if (existingReference !== null) {
          return existingReference;
        }

        const stubDefinitionId = stubDefinitionIdFromInput(
          input,
          definitionIds
        );

        if (stubDefinitionId === null) {
          return null;
        }

        yield* validateStubDefinitionId(stubDefinitionId, definitionIds);
        const stubDefinition = definitionsById.get(stubDefinitionId);

        if (stubDefinition === undefined) {
          return yield* definitionNotFoundError(stubDefinitionId);
        }

        return yield* createStubReference({
          definition: stubDefinition,
          sourceIdentity,
        });
      });

      return { lookup };
    })
  );
