import { Effect, Layer, Schema } from "effect";
import type { MigrationDefinitionId, SourceIdentity } from "../domain/ids.ts";
import type { AnyMigrationDefinition } from "../domain/run.ts";
import type { SourceItem } from "../domain/source.ts";
import type { MigrationItemState } from "../domain/state.ts";
import {
  DuplicateSourceIdentityStatusWarning,
  type GetMigrationStatusesError,
  InvalidSourceItemStatusWarning,
  type MigrationDefinitionSourceStatus,
  type MigrationDefinitionStatus,
  type MigrationStatusReport,
  MigrationStatusRequestError,
  type MigrationStatusRequestInput,
  type MigrationStatusWarning,
  makeMigrationStatusRequest,
  summarizeMigrationItemStates,
} from "../domain/status.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  type AnySourcePlugin,
  SourcePlugin,
} from "../services/source-plugin.ts";
import { normalizeSourcePayloadSchemaError } from "./item-error.ts";

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

const getScannedDefinitionStatus = (
  definition: AnyMigrationDefinition
): Effect.Effect<MigrationDefinitionStatus, GetMigrationStatusesError> => {
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
    Effect.provide(Layer.mergeAll(definition.source.layer, definition.store))
  );
};

const getDefinitionStatus = (
  definition: AnyMigrationDefinition,
  scanSource: boolean
): Effect.Effect<MigrationDefinitionStatus, GetMigrationStatusesError> =>
  scanSource
    ? getScannedDefinitionStatus(definition)
    : getDurableDefinitionStatus(definition);

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

    const selectedDefinitions = yield* selectDefinitions(
      request.definitions,
      request.definitionIds
    );
    const definitions = yield* Effect.forEach(
      selectedDefinitions,
      (definition) => getDefinitionStatus(definition, request.scanSource),
      { concurrency: request.scanSource ? request.concurrency : 1 }
    );

    return {
      definitions,
      scanSource: request.scanSource,
      warnings: definitions.flatMap((definition) => definition.warnings),
    };
  });
