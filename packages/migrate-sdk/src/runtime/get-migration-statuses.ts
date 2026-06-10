import { Effect } from "effect";
import type { MigrationDefinitionId } from "../domain/ids.ts";
import type { AnyMigrationDefinition } from "../domain/run.ts";
import {
  type GetMigrationStatusesError,
  type MigrationDefinitionStatus,
  type MigrationStatusReport,
  MigrationStatusRequestError,
  type MigrationStatusRequestInput,
  makeMigrationStatusRequest,
} from "../domain/status.ts";
import { MigrationStore } from "../services/migration-store.ts";

const missingDefinitionError = (definitionId: MigrationDefinitionId) =>
  new MigrationStatusRequestError({
    message: "Migration Definition was not found",
    cause: { definitionId },
  });

const invalidStatusRequestError = (cause: unknown) =>
  cause instanceof MigrationStatusRequestError
    ? cause
    : new MigrationStatusRequestError({
        message: "Status request contains invalid input",
        cause,
      });

const unsupportedSourceScanError = () =>
  new MigrationStatusRequestError({
    message: "Source inventory scanning is not available yet",
  });

const selectDefinitions = (
  definitions: readonly AnyMigrationDefinition[],
  definitionIds?: readonly MigrationDefinitionId[]
): Effect.Effect<
  readonly AnyMigrationDefinition[],
  MigrationStatusRequestError
> => {
  if (definitionIds === undefined) {
    return Effect.succeed(definitions);
  }

  const selectedDefinitionIds = new Set(definitionIds);
  const selectedDefinitions = definitions.filter((definition) =>
    selectedDefinitionIds.has(definition.id)
  );
  const knownDefinitionIds = new Set(
    definitions.map((definition) => definition.id)
  );

  for (const definitionId of definitionIds) {
    if (!knownDefinitionIds.has(definitionId)) {
      return Effect.fail(missingDefinitionError(definitionId));
    }
  }

  return Effect.succeed(selectedDefinitions);
};

const getDefinitionStatus = (
  definition: AnyMigrationDefinition
): Effect.Effect<MigrationDefinitionStatus, GetMigrationStatusesError> =>
  Effect.gen(function* () {
    const store = yield* MigrationStore;
    const lastRun = yield* store.getLatestRunState(definition.id);
    const durable = yield* store.getItemStateSummary(definition.id);

    return {
      definitionId: definition.id,
      durable,
      lastRun,
      warnings: [],
    };
  }).pipe(Effect.provide(definition.store));

export const getMigrationStatuses = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: MigrationStatusRequestInput<Definitions>
): Effect.Effect<MigrationStatusReport, GetMigrationStatusesError> =>
  Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => makeMigrationStatusRequest(input),
      catch: invalidStatusRequestError,
    });

    if (request.scanSource) {
      return yield* unsupportedSourceScanError();
    }

    const selectedDefinitions = yield* selectDefinitions(
      request.definitions,
      request.definitionIds
    );
    const definitions: MigrationDefinitionStatus[] = [];

    for (const definition of selectedDefinitions) {
      definitions.push(yield* getDefinitionStatus(definition));
    }

    return {
      definitions,
      scanSource: request.scanSource,
      warnings: [],
    };
  });
