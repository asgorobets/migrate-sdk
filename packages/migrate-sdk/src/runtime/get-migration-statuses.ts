import { Effect, Layer, Schema } from "effect";
import type { MigrationDefinitionId, SourceIdentity } from "../domain/ids.ts";
import type {
  AnyMigrationDefinition,
  RunRequestSourceLayerError,
  RunRequestSourceRequirements,
} from "../domain/run.ts";
import type { SourceItem } from "../domain/source.ts";
import type { MigrationItemState } from "../domain/state.ts";
import {
  DuplicateSourceIdentityStatusWarning,
  type DurableMigrationStatusRequestInput,
  type GetMigrationStatusesError,
  InvalidSourceItemStatusWarning,
  type MigrationDefinitionSourceStatus,
  type MigrationDefinitionStatus,
  type MigrationStatusReport,
  MigrationStatusRequestError,
  type MigrationStatusRequestInput,
  type MigrationStatusWarning,
  type SourceScanMigrationStatusRequestInput,
  makeMigrationStatusRequest,
  summarizeMigrationItemStates,
} from "../domain/status.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  type AnySourcePlugin,
  SourcePlugin,
} from "../services/source-plugin.ts";
import { normalizeSourcePayloadSchemaError } from "./item-error.ts";

type GetMigrationStatusesImplementationEffect = Effect.Effect<
  MigrationStatusReport,
  // biome-ignore lint/suspicious/noExplicitAny: Hidden implementation signature; public overloads keep precise status errors.
  any,
  // biome-ignore lint/suspicious/noExplicitAny: Hidden implementation signature; public overloads keep precise status requirements.
  any
>;

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

const selectDefinitions = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  definitions: Definitions,
  definitionIds?: readonly MigrationDefinitionId[]
): Effect.Effect<
  readonly Definitions[number][],
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

interface SourceInventoryScan {
  readonly source: MigrationDefinitionSourceStatus;
  readonly warnings: readonly MigrationStatusWarning[];
}

const readSourceInventory = (
  definition: AnyMigrationDefinition,
  source: AnySourcePlugin
): Effect.Effect<readonly SourceItem<unknown>[], GetMigrationStatusesError> =>
  Effect.gen(function* () {
    const items: SourceItem<unknown>[] = [];
    let cursor: unknown | null = null;

    while (true) {
      const read = source.read(cursor);
      const readWithRetry =
        definition.sourceCursorRetry === undefined
          ? read
          : definition.sourceCursorRetry(read);
      const readResult = yield* readWithRetry;
      items.push(...readResult.items);

      if (readResult.nextCursor === undefined) {
        break;
      }

      cursor = readResult.nextCursor;
    }

    return items;
  });

const validateSourceItem = (
  definitionId: MigrationDefinitionId,
  source: AnySourcePlugin,
  sourceItem: SourceItem<unknown>
): Effect.Effect<MigrationStatusWarning | null> =>
  Schema.decodeUnknownEffect(source.sourceSchema, { errors: "all" })(
    sourceItem.item
  ).pipe(
    Effect.as(null),
    Effect.catch((error) => {
      const normalized = normalizeSourcePayloadSchemaError(error);

      return Effect.succeed(
        new InvalidSourceItemStatusWarning({
          definitionId,
          message: normalized.message,
          sourceIdentity: sourceItem.identity,
          ...(normalized.details === undefined
            ? {}
            : { details: normalized.details }),
        })
      );
    })
  );

const scanSourceInventory = (
  definition: AnyMigrationDefinition,
  source: AnySourcePlugin,
  itemStates: readonly MigrationItemState[]
): Effect.Effect<SourceInventoryScan, GetMigrationStatusesError> =>
  Effect.gen(function* () {
    const sourceItems = yield* readSourceInventory(definition, source);
    const durableSourceIdentities = new Set(
      itemStates.map((itemState) => itemState.sourceIdentity)
    );
    const seenSourceIdentities = new Set<SourceIdentity>();
    const currentSourceIdentities = new Set<SourceIdentity>();
    const duplicateCounts = new Map<SourceIdentity, number>();
    const warnings: MigrationStatusWarning[] = [];
    let invalid = 0;
    let duplicate = 0;
    let unprocessed = 0;

    for (const sourceItem of sourceItems) {
      currentSourceIdentities.add(sourceItem.identity);

      const validationWarning = yield* validateSourceItem(
        definition.id,
        source,
        sourceItem
      );
      const isInvalid = validationWarning !== null;

      if (isInvalid) {
        invalid += 1;
        warnings.push(validationWarning);
      }

      if (seenSourceIdentities.has(sourceItem.identity)) {
        duplicate += 1;
        duplicateCounts.set(
          sourceItem.identity,
          (duplicateCounts.get(sourceItem.identity) ?? 0) + 1
        );
        continue;
      }

      seenSourceIdentities.add(sourceItem.identity);

      if (!(isInvalid || durableSourceIdentities.has(sourceItem.identity))) {
        unprocessed += 1;
      }
    }

    for (const [sourceIdentity, count] of duplicateCounts) {
      warnings.push(
        new DuplicateSourceIdentityStatusWarning({
          count,
          definitionId: definition.id,
          sourceIdentity,
        })
      );
    }

    const orphaned = itemStates.filter(
      (itemState) => !currentSourceIdentities.has(itemState.sourceIdentity)
    ).length;

    return {
      source: {
        duplicate,
        invalid,
        orphaned,
        total: sourceItems.length,
        unprocessed,
      },
      warnings,
    };
  });

const getDurableDefinitionStatus = (
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

const getScannedDefinitionStatus = <Definition extends AnyMigrationDefinition>(
  definition: Definition
): Effect.Effect<
  MigrationDefinitionStatus,
  GetMigrationStatusesError | RunRequestSourceLayerError<readonly [Definition]>,
  RunRequestSourceRequirements<readonly [Definition]>
> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const source = yield* SourcePlugin;
    const lastRun = yield* store.getLatestRunState(definition.id);
    const itemStates = yield* store.listItemStates(definition.id);
    const durable = summarizeMigrationItemStates(itemStates);
    const scan = yield* scanSourceInventory(definition, source, itemStates);

    return {
      definitionId: definition.id,
      durable,
      lastRun,
      source: scan.source,
      warnings: scan.warnings,
    };
  });

  return program.pipe(
    Effect.provide(
      definition.source.layer.pipe(Layer.provideMerge(definition.store))
    )
  );
};

export function getMigrationStatuses<
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: DurableMigrationStatusRequestInput<Definitions>
): Effect.Effect<MigrationStatusReport, GetMigrationStatusesError, never>;
export function getMigrationStatuses<
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: SourceScanMigrationStatusRequestInput<Definitions>
): Effect.Effect<
  MigrationStatusReport,
  GetMigrationStatusesError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
>;
export function getMigrationStatuses<
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: MigrationStatusRequestInput<Definitions>
): Effect.Effect<
  MigrationStatusReport,
  GetMigrationStatusesError | RunRequestSourceLayerError<Definitions>,
  RunRequestSourceRequirements<Definitions>
>;
export function getMigrationStatuses<
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input:
    | DurableMigrationStatusRequestInput<Definitions>
    | SourceScanMigrationStatusRequestInput<Definitions>
    | MigrationStatusRequestInput<Definitions>
): GetMigrationStatusesImplementationEffect {
  return Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => makeMigrationStatusRequest(input),
      catch: invalidStatusRequestError,
    });

    const selectedDefinitions = yield* selectDefinitions(
      request.definitions,
      request.definitionIds
    );

    if (request.scanSource) {
      const definitions = yield* Effect.forEach(
        selectedDefinitions,
        getScannedDefinitionStatus,
        { concurrency: request.concurrency }
      );

      return {
        definitions,
        scanSource: true,
        warnings: definitions.flatMap((definition) => definition.warnings),
      };
    }

    const definitions = yield* Effect.forEach(
      selectedDefinitions,
      getDurableDefinitionStatus,
      { concurrency: 1 }
    );

    return {
      definitions,
      scanSource: false,
      warnings: definitions.flatMap((definition) => definition.warnings),
    };
  }) as GetMigrationStatusesImplementationEffect;
}
