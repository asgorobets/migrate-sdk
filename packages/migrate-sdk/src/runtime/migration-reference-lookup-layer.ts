import { Cache, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
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
import type {
  TrackingRecord,
  TrackingRecordContract,
} from "../domain/tracking.ts";
import {
  type AnyMigrationReferenceLookupInput,
  type MigrationReference,
  MigrationReferenceLookup,
  type MigrationReferenceLookupService,
  type MigrationReferenceLookupTarget,
  type MigrationReferenceLookupTargetSet,
  makeMigrationReferenceLookupTarget,
} from "../services/migration-reference-lookup.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  isMigrationRuntimeError,
  validateMigrationContract,
} from "./migration-contract-validation.ts";

const lookupContractValidationCacheCapacity = 100;

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

const missingTrackingRecordContractError = (
  definitionId: MigrationDefinitionId
) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Reference Lookup requires referenced Migration Definition to declare a Tracking Record Contract",
    cause: { definitionId },
  });

const invalidTrackingRecordError = (
  definitionId: MigrationDefinitionId,
  sourceIdentity: EncodedSourceIdentity,
  cause: Schema.SchemaError
) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Reference tracking record did not match Tracking Record Contract",
    cause: { definitionId, sourceIdentity, cause },
  });

const missingTrackingRecordError = (
  definitionId: MigrationDefinitionId,
  sourceIdentity: EncodedSourceIdentity
) =>
  new MigrationReferenceLookupError({
    message:
      "Migration Reference tracking record is missing from migrated item state",
    cause: { definitionId, sourceIdentity },
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

const isLookupableState = (
  state: MigrationItemState | null
): state is Extract<
  MigrationItemState,
  { readonly status: "migrated" | "needs-update" }
> => state?.status === "migrated" || state?.status === "needs-update";

const referenceFromTrackingRecordState = (
  definition: AnyMigrationDefinition,
  state: Extract<
    MigrationItemState,
    { readonly status: "migrated" | "needs-update" }
  >
): Effect.Effect<MigrationReference | null, MigrationReferenceLookupError> => {
  const contract = definition.tracking as TrackingRecordContract | undefined;

  if (contract === undefined) {
    return Effect.fail(missingTrackingRecordContractError(definition.id));
  }

  if (state.trackingRecord === undefined) {
    return Effect.fail(
      missingTrackingRecordError(definition.id, state.sourceIdentity.encoded)
    );
  }

  return Schema.decodeUnknownEffect(contract.schema, { errors: "all" })(
    state.trackingRecord
  ).pipe(
    Effect.map(
      (trackingRecord): MigrationReference => ({
        definitionId: state.definitionId,
        sourceIdentity: state.sourceIdentity.encoded,
        status: state.status,
        trackingRecord: trackingRecord as TrackingRecord,
      })
    ),
    Effect.mapError((cause) =>
      invalidTrackingRecordError(
        definition.id,
        state.sourceIdentity.encoded,
        cause
      )
    )
  );
};

const referenceFromState = (
  definition: AnyMigrationDefinition,
  state: MigrationItemState | null
): Effect.Effect<MigrationReference | null, MigrationReferenceLookupError> => {
  if (!isLookupableState(state)) {
    if (definition.tracking === undefined) {
      return Effect.fail(missingTrackingRecordContractError(definition.id));
    }

    return Effect.succeed(null);
  }

  return referenceFromTrackingRecordState(definition, state);
};

const getReferenceState = (
  definition: AnyMigrationDefinition,
  sourceIdentity: EncodedSourceIdentity
) =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;

    return yield* store.getItemState(definition.id, sourceIdentity);
  }).pipe(Effect.provide(definition.store));

const validateLookupTargetContract = (definition: AnyMigrationDefinition) =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;

    yield* validateMigrationContract(store, definition).pipe(
      Effect.mapError((error) =>
        isMigrationRuntimeError(error)
          ? new MigrationReferenceLookupError({
              message: error.message,
              cause: error,
            })
          : error
      )
    );
  }).pipe(Effect.provide(definition.store));

type LookupContractValidationCache = Cache.Cache<
  AnyMigrationDefinition,
  void,
  MigrationReferenceLookupError | MigrationStoreError
>;

const lookupContractValidationTimeToLive = (
  exit: Exit.Exit<void, MigrationReferenceLookupError | MigrationStoreError>
) => {
  const error = Exit.findErrorOption(exit);

  return Option.isSome(error) && error.value._tag === "MigrationStoreError"
    ? Duration.zero
    : Duration.infinity;
};

const makeLookupContractValidationCache = () =>
  Cache.makeWith(validateLookupTargetContract, {
    capacity: lookupContractValidationCacheCapacity,
    timeToLive: lookupContractValidationTimeToLive,
  });

const validateLookupTargetContracts = (
  cache: LookupContractValidationCache,
  targets: MigrationReferenceLookupTargetSet
) =>
  Effect.forEach(targets, (target) => Cache.get(cache, target.definition)).pipe(
    Effect.asVoid
  );

const findExistingReference = (targets: MigrationReferenceLookupTargetSet) =>
  Effect.gen(function* () {
    for (const target of targets) {
      const sourceIdentity = yield* sourceIdentityForTarget(target);
      const state = yield* getReferenceState(target.definition, sourceIdentity);
      const reference = yield* referenceFromState(target.definition, state);

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
    Effect.gen(function* () {
      const contractValidationCache =
        yield* makeLookupContractValidationCache();

      return {
        lookup: Effect.fn("MigrationReferenceLookup.lookup")(function* (
          input: AnyMigrationReferenceLookupInput
        ) {
          const targets = targetsFromInput(input);
          yield* validateLookupTargetContracts(
            contractValidationCache,
            targets
          );

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
        }) as MigrationReferenceLookupService["lookup"],
        target: makeMigrationReferenceLookupTarget,
      };
    })
  );
