import { Effect, Predicate } from "effect";
import {
  MigrationRuntimeError,
  type MigrationStoreError,
} from "../domain/errors.ts";
import type { MigrationDefinitionId } from "../domain/ids.ts";
import type { MigrationContract } from "../domain/migration-contract.ts";
import type { AnyMigrationDefinition } from "../domain/run.ts";
import type { MigrationStore } from "../services/migration-store.ts";

const sourceContractChangedError = (
  definitionId: MigrationDefinitionId,
  stored: MigrationContract | null,
  current: MigrationContract
) =>
  new MigrationRuntimeError({
    message: "Migration Definition source contract changed",
    cause: {
      definitionId,
      current,
      stored,
    },
  });

const trackingContractChangedError = (
  definitionId: MigrationDefinitionId,
  stored: MigrationContract | null,
  current: MigrationContract
) =>
  new MigrationRuntimeError({
    message: "Migration Definition tracking record contract changed",
    cause: {
      definitionId,
      current,
      stored,
    },
  });

const makeMigrationContract = (
  definition: AnyMigrationDefinition
): MigrationContract => ({
  definitionId: definition.id,
  sourceIdentityContractFingerprint:
    definition.source.sourceIdentityContractFingerprint,
  sourceVersionContractFingerprint:
    definition.source.sourceVersionContractFingerprint,
  ...(definition.tracking === undefined
    ? {}
    : {
        trackingRecordContractFingerprint: definition.tracking.fingerprint,
        trackingRecordContractId: definition.tracking.id,
      }),
});

const sourceIdentityContractsMatch = (
  left: MigrationContract,
  right: MigrationContract
): boolean =>
  left.sourceIdentityContractFingerprint ===
  right.sourceIdentityContractFingerprint;

const trackingRecordContractsMatch = (
  left: MigrationContract,
  right: MigrationContract
): boolean =>
  left.trackingRecordContractId === right.trackingRecordContractId &&
  left.trackingRecordContractFingerprint ===
    right.trackingRecordContractFingerprint;

export const isMigrationRuntimeError = (
  error: unknown
): error is MigrationRuntimeError =>
  Predicate.isTagged(error, "MigrationRuntimeError");

export const validateMigrationContract = (
  store: typeof MigrationStore.Service,
  definition: AnyMigrationDefinition
): Effect.Effect<void, MigrationStoreError | MigrationRuntimeError> =>
  Effect.gen(function* () {
    const current = makeMigrationContract(definition);
    const stored = yield* store.getMigrationContract(definition.id);

    if (stored === null) {
      const itemStates = yield* store.listItemStates(definition.id);

      if (itemStates.length === 0) {
        yield* store.upsertMigrationContract(current);
        return;
      }

      return yield* sourceContractChangedError(definition.id, stored, current);
    }

    if (
      sourceIdentityContractsMatch(stored, current) &&
      trackingRecordContractsMatch(stored, current)
    ) {
      if (
        stored.sourceVersionContractFingerprint !==
        current.sourceVersionContractFingerprint
      ) {
        yield* store.upsertMigrationContract(current);
      }

      return;
    }

    const itemStates = yield* store.listItemStates(definition.id);

    if (itemStates.length === 0) {
      yield* store.upsertMigrationContract(current);
      return;
    }

    if (!sourceIdentityContractsMatch(stored, current)) {
      return yield* sourceContractChangedError(definition.id, stored, current);
    }

    if (!trackingRecordContractsMatch(stored, current)) {
      return yield* trackingContractChangedError(
        definition.id,
        stored,
        current
      );
    }

    return yield* sourceContractChangedError(definition.id, stored, current);
  });

export const validateMigrationContracts = (
  store: typeof MigrationStore.Service,
  definitions: readonly AnyMigrationDefinition[]
): Effect.Effect<void, MigrationStoreError | MigrationRuntimeError> =>
  Effect.forEach(definitions, (definition) =>
    validateMigrationContract(store, definition)
  ).pipe(Effect.asVoid);
