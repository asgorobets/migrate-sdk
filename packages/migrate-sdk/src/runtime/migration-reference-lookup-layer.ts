import { Effect, Layer } from "effect";
import {
  type DestinationPluginError,
  MigrationReferenceLookupError,
  type MigrationStoreError,
} from "../domain/errors.ts";
import type {
  EncodedSourceIdentity,
  MigrationDefinitionId,
} from "../domain/ids.ts";
import { SourceIdentity } from "../domain/ids.ts";
import type { AnyMigrationDefinition } from "../domain/run.ts";
import type { MigrationItemState } from "../domain/state.ts";
import {
  type AnyMigrationReferenceLookupInput,
  type MigrationReference,
  MigrationReferenceLookup,
  type MigrationReferenceLookupTarget,
  type MigrationReferenceLookupTargetSet,
  makeMigrationReferenceLookupTarget,
} from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";

export type CreateMigrationReferenceStub = (input: {
  readonly definition: AnyMigrationDefinition;
  readonly sourceIdentity: EncodedSourceIdentity;
}) => Effect.Effect<
  MigrationReference,
  DestinationPluginError | MigrationReferenceLookupError | MigrationStoreError
>;

const stubDefinitionNotInLookupError = (
  definitionId: MigrationDefinitionId,
  definitionIds: readonly MigrationDefinitionId[]
) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Reference Lookup stub definition must be one of the lookup targets",
    cause: { definitionId, definitionIds },
  });

const targetsFromInput = (
  input: AnyMigrationReferenceLookupInput
): MigrationReferenceLookupTargetSet =>
  "targets" in input && input.targets !== undefined
    ? input.targets
    : [
        makeMigrationReferenceLookupTarget(
          input.definition,
          input.sourceIdentityKey
        ),
      ];

const sourceIdentityForTarget = (
  target: MigrationReferenceLookupTarget<AnyMigrationDefinition>
): Effect.Effect<EncodedSourceIdentity, MigrationReferenceLookupError> =>
  Effect.try({
    try: () =>
      SourceIdentity.fromKey(
        target.definition.source.identity,
        target.sourceIdentityKey
      ).encoded,
    catch: (cause) =>
      new MigrationReferenceLookupError({
        message:
          "Migration Reference Lookup source identity key did not match Source Identity Schema",
        cause,
      }),
  });

const stubDefinitionFromInput = (
  input: AnyMigrationReferenceLookupInput,
  targets: MigrationReferenceLookupTargetSet
): Effect.Effect<
  MigrationReferenceLookupTarget<AnyMigrationDefinition> | null,
  MigrationReferenceLookupError
> => {
  const stub = input.stub;

  if (stub !== true && typeof stub !== "object") {
    return Effect.succeed(null);
  }

  if (stub !== true && stub.definition !== undefined) {
    const target = targets.find(
      (lookupTarget) => lookupTarget.definition === stub.definition
    );

    if (target !== undefined) {
      return Effect.succeed(target);
    }

    return Effect.fail(
      stubDefinitionNotInLookupError(
        stub.definition.id,
        targets.map((lookupTarget) => lookupTarget.definition.id)
      )
    );
  }

  return Effect.succeed(targets[0]);
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
        sourceIdentity: state.sourceIdentity.encoded,
        status: state.status,
      }
    : null;

const getReferenceState = (
  definition: AnyMigrationDefinition,
  sourceIdentity: EncodedSourceIdentity
) =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;

    return yield* store.getItemState(definition.id, sourceIdentity);
  }).pipe(Effect.provide(definition.store));

const findExistingReference = (targets: MigrationReferenceLookupTargetSet) =>
  Effect.gen(function* () {
    for (const target of targets) {
      const sourceIdentity = yield* sourceIdentityForTarget(target);
      const state = yield* getReferenceState(target.definition, sourceIdentity);
      const reference = referenceFromState(state);

      if (reference !== null) {
        return reference;
      }
    }

    return null;
  });

export const makeMigrationReferenceLookupLayer = ({
  createStubReference,
}: {
  readonly createStubReference: CreateMigrationReferenceStub;
}): Layer.Layer<MigrationReferenceLookup> =>
  Layer.effect(
    MigrationReferenceLookup,
    Effect.succeed({
      lookup: Effect.fn("MigrationReferenceLookup.lookup")(function* (
        input: AnyMigrationReferenceLookupInput
      ) {
        const targets = targetsFromInput(input);
        const existingReference = yield* findExistingReference(targets);

        if (existingReference !== null) {
          return existingReference;
        }

        const stubTarget = yield* stubDefinitionFromInput(input, targets);

        if (stubTarget === null) {
          return null;
        }

        const sourceIdentity = yield* sourceIdentityForTarget(stubTarget);

        return yield* createStubReference({
          definition: stubTarget.definition,
          sourceIdentity,
        });
      }),
      target: makeMigrationReferenceLookupTarget,
    })
  );
