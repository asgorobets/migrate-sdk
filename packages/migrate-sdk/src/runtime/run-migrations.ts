import { Effect, Exit, Layer, Schema } from "effect";
import type { MigrationDefinition } from "../domain/definition.ts";
import type { DestinationCommand } from "../domain/destination.ts";
import {
  MigrationRuntimeError,
  MigrationStoreError,
  SourcePluginError,
} from "../domain/errors.ts";
import type {
  MigrationDefinitionId,
  MigrationRunId,
  SourceIdentity,
} from "../domain/ids.ts";
import { toEncodedSourceCursor } from "../domain/ids.ts";
import type { MigrationDefinitionLock } from "../domain/lock.ts";
import type {
  AnyMigrationDefinition,
  MigrationDefinitionRunSummary,
  MigrationRunSummary,
  RunRequestInput,
} from "../domain/run.ts";
import { makeRunRequest } from "../domain/run.ts";
import { normalRunMode, type RunMode } from "../domain/run-mode.ts";
import type {
  FailedItemState,
  MigrationItemOutcome,
  MigrationItemState,
} from "../domain/state.ts";
import { MigrationStore } from "../services/migration-store.ts";
import {
  getSourcePlugin,
  type SourcePlugin,
} from "../services/source-plugin.ts";
import { normalizeItemError } from "./item-error.ts";
import { processSourceItem } from "./process-source-item.ts";

export type RunMigrationDefinitionError =
  | SourcePluginError
  | MigrationStoreError;

export type RunMigrationError =
  | MigrationRuntimeError
  | RunMigrationDefinitionError;

const emptyRunError = new MigrationRuntimeError({
  message: "Run request must include at least one Migration Definition",
});

const missingDefinitionError = (definitionId: MigrationDefinitionId) =>
  new MigrationRuntimeError({
    message: "Migration Definition was not found",
    cause: { definitionId },
  });

const dependencyCycleError = (definitionId: MigrationDefinitionId) =>
  new MigrationRuntimeError({
    message: "Migration Definition dependency cycle detected",
    cause: { definitionId },
  });

const splitStoreRunError = (
  definitionId: MigrationDefinitionId,
  storeOwnerDefinitionId: MigrationDefinitionId
) =>
  new MigrationRuntimeError({
    message:
      "Migration Definitions in the same run must use the same Migration Store",
    cause: { definitionId, storeOwnerDefinitionId },
  });

const invalidRunRequestError = (cause: unknown) =>
  new MigrationRuntimeError({
    message: "Run request contains invalid input",
    cause,
  });

const failRunFinalizationError = <Error>(
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  primaryError: Error,
  failRunError: MigrationStoreError
) =>
  new MigrationStoreError({
    message: "Unable to mark Migration Run failed",
    cause: { definitionIds, failRunError, primaryError, runId },
  });

interface LockReleaseFailure {
  readonly error: MigrationStoreError;
  readonly lock: MigrationDefinitionLock;
}

const lockReleaseFailureError = (
  failures: readonly LockReleaseFailure[],
  primaryExit?: Exit.Exit<unknown, unknown>
) =>
  new MigrationStoreError({
    message: "Unable to release Migration Definition Lock set",
    cause: {
      releaseFailures: failures.map(({ error, lock }) => ({
        definitionId: lock.definitionId,
        error,
        ownerRunId: lock.ownerRunId,
        token: lock.token,
      })),
      ...(primaryExit !== undefined && Exit.isFailure(primaryExit)
        ? { primaryCause: primaryExit.cause }
        : {}),
    },
  });

const emptyCounts = {
  migrated: 0,
  skipped: 0,
  failed: 0,
  unchanged: 0,
  needsUpdate: 0,
};

interface MutableDefinitionCounts {
  failed: number;
  migrated: number;
  needsUpdate: number;
  skipped: number;
  unchanged: number;
}

const runStatusForDefinitions = (
  definitions: readonly MigrationDefinitionRunSummary[]
): MigrationRunSummary["status"] =>
  definitions.some((definition) => definition.status === "failed")
    ? "failed"
    : "succeeded";

const failRunAndRethrow = <Error>(
  store: typeof MigrationStore.Service,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[],
  error: Error
): Effect.Effect<never, Error | MigrationStoreError> =>
  store.failRun(runId, definitionIds).pipe(
    Effect.mapError((failRunError) =>
      failRunFinalizationError(runId, definitionIds, error, failRunError)
    ),
    Effect.flatMap(() => Effect.fail(error))
  );

const lockDefinitionIds = (
  definitionIds: readonly MigrationDefinitionId[]
): readonly MigrationDefinitionId[] =>
  Array.from(new Set(definitionIds)).sort((left, right) =>
    left.localeCompare(right)
  );

const releaseDefinitionLocks = (
  store: typeof MigrationStore.Service,
  locks: readonly MigrationDefinitionLock[],
  primaryExit?: Exit.Exit<unknown, unknown>
): Effect.Effect<void, MigrationStoreError> =>
  Effect.gen(function* () {
    const failures: LockReleaseFailure[] = [];

    for (const lock of [...locks].reverse()) {
      yield* store.releaseDefinitionLock(lock).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failures.push({ error, lock });
          })
        )
      );
    }

    if (failures.length > 0) {
      return yield* lockReleaseFailureError(failures, primaryExit);
    }
  });

const acquireDefinitionLocks = (
  store: typeof MigrationStore.Service,
  runId: MigrationRunId,
  definitionIds: readonly MigrationDefinitionId[]
): Effect.Effect<readonly MigrationDefinitionLock[], MigrationStoreError> =>
  Effect.gen(function* () {
    const locks: MigrationDefinitionLock[] = [];

    for (const definitionId of lockDefinitionIds(definitionIds)) {
      const lock = yield* store
        .acquireDefinitionLock(definitionId, runId)
        .pipe(
          Effect.catch((error) =>
            releaseDefinitionLocks(store, locks, Exit.fail(error)).pipe(
              Effect.flatMap(() => Effect.fail(error))
            )
          )
        );
      locks.push(lock);
    }

    return locks;
  });

const encodeSourceCursor = <Cursor>(
  cursorSchema: Schema.Codec<Cursor, unknown, never, never>,
  cursor: Cursor
) =>
  Schema.encodeEffect(Schema.fromJsonString(cursorSchema))(cursor).pipe(
    Effect.map(toEncodedSourceCursor),
    Effect.mapError(
      (cause) =>
        new MigrationStoreError({
          message: "Unable to encode Source Cursor for durable storage",
          cause,
        })
    )
  );

const decodeSourceCursor = <Cursor>(
  cursorSchema: Schema.Codec<Cursor, unknown, never, never>,
  cursor: string
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(cursorSchema))(cursor).pipe(
    Effect.mapError(
      (cause) =>
        new MigrationStoreError({
          message: "Unable to decode stored Source Cursor",
          cause,
        })
    )
  );

type OrderedDefinitionsResult =
  | {
      readonly definitions: readonly AnyMigrationDefinition[];
      readonly kind: "ordered";
    }
  | {
      readonly error: MigrationRuntimeError;
      readonly kind: "failed";
    };

const orderDefinitions = (
  definitions: readonly AnyMigrationDefinition[],
  selectedDefinitionIds: readonly MigrationDefinitionId[] | undefined
): OrderedDefinitionsResult => {
  const definitionsById = new Map(
    definitions.map((definition) => [definition.id, definition])
  );
  const orderedDefinitions: AnyMigrationDefinition[] = [];
  const activeDefinitionIds = new Set<MigrationDefinitionId>();
  const visitedDefinitionIds = new Set<MigrationDefinitionId>();
  const rootDefinitionIds =
    selectedDefinitionIds === undefined
      ? definitions.map((definition) => definition.id)
      : selectedDefinitionIds;

  const visit = (
    definitionId: MigrationDefinitionId
  ): MigrationRuntimeError | null => {
    if (visitedDefinitionIds.has(definitionId)) {
      return null;
    }

    if (activeDefinitionIds.has(definitionId)) {
      return dependencyCycleError(definitionId);
    }

    const definition = definitionsById.get(definitionId);

    if (definition === undefined) {
      return missingDefinitionError(definitionId);
    }

    activeDefinitionIds.add(definitionId);

    for (const dependencyId of definition.dependsOn ?? []) {
      const error = visit(dependencyId);

      if (error !== null) {
        activeDefinitionIds.delete(definitionId);
        return error;
      }
    }

    activeDefinitionIds.delete(definitionId);
    visitedDefinitionIds.add(definitionId);
    orderedDefinitions.push(definition);

    return null;
  };

  for (const definitionId of rootDefinitionIds) {
    const error = visit(definitionId);

    if (error !== null) {
      return { kind: "failed", error };
    }
  }

  return { kind: "ordered", definitions: orderedDefinitions };
};

const validateSharedStore = (
  definitions: readonly AnyMigrationDefinition[]
): MigrationRuntimeError | null => {
  const firstDefinition = definitions[0];

  if (firstDefinition === undefined) {
    return null;
  }

  for (const definition of definitions) {
    if (definition.store !== firstDefinition.store) {
      return splitStoreRunError(definition.id, firstDefinition.id);
    }
  }

  return null;
};

const isTargetedMode = (mode: RunMode): boolean => mode.kind !== "normal";

const shouldReprocessUnchangedTerminal = (mode: RunMode): boolean =>
  mode.kind === "skipped" || mode.kind === "item";

const selectBacklogStates = (
  mode: RunMode,
  itemStates: readonly MigrationItemState[]
): readonly MigrationItemState[] => {
  switch (mode.kind) {
    case "normal": {
      return itemStates.filter(
        (itemState) =>
          itemState.status === "failed" || itemState.status === "needs-update"
      );
    }
    case "failed": {
      return itemStates.filter((itemState) => itemState.status === "failed");
    }
    case "skipped": {
      return itemStates.filter((itemState) => itemState.status === "skipped");
    }
    case "item": {
      return [];
    }
    default: {
      const unhandledMode: never = mode;
      throw new Error(`Unhandled Run Mode: ${unhandledMode}`);
    }
  }
};

const sourceIdentitiesForMode = (
  mode: RunMode,
  backlogStates: readonly MigrationItemState[]
): readonly SourceIdentity[] =>
  mode.kind === "item"
    ? [mode.sourceIdentity]
    : backlogStates.map((itemState) => itemState.sourceIdentity);

const previousDestinationIdentity = (
  previousState: MigrationItemState | null
) =>
  previousState !== null &&
  (previousState.status === "migrated" ||
    previousState.status === "failed" ||
    previousState.status === "needs-update")
    ? previousState.destinationIdentity
    : undefined;

const previousDestinationVersion = (
  previousState: MigrationItemState | null
) =>
  previousState !== null &&
  (previousState.status === "migrated" ||
    previousState.status === "failed" ||
    previousState.status === "needs-update")
    ? previousState.destinationVersion
    : undefined;

const makeSourceLookupFailedItemState = (
  definitionId: MigrationDefinitionId,
  runId: MigrationRunId,
  sourceIdentity: SourceIdentity,
  previousState: MigrationItemState,
  error: unknown
): FailedItemState => ({
  definitionId,
  sourceIdentity,
  sourceVersion: previousState.sourceVersion,
  ...(previousDestinationIdentity(previousState) === undefined
    ? {}
    : { destinationIdentity: previousDestinationIdentity(previousState) }),
  ...(previousDestinationVersion(previousState) === undefined
    ? {}
    : { destinationVersion: previousDestinationVersion(previousState) }),
  lastRunId: runId,
  updatedAt: new Date(),
  status: "failed",
  error: normalizeItemError("source", error),
});

const addOutcomeToCounts = (
  counts: MutableDefinitionCounts,
  outcome: MigrationItemOutcome
) => {
  switch (outcome) {
    case "migrated": {
      counts.migrated += 1;
      break;
    }
    case "skipped": {
      counts.skipped += 1;
      break;
    }
    case "failed": {
      counts.failed += 1;
      break;
    }
    case "unchanged": {
      counts.unchanged += 1;
      break;
    }
    case "needs-update": {
      counts.needsUpdate += 1;
      break;
    }
    default: {
      const unhandledOutcome: never = outcome;
      throw new Error(`Unhandled Migration Item Outcome: ${unhandledOutcome}`);
    }
  }
};

interface ProcessTargetedSourceIdentitiesOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor
  >;
  readonly itemStates: readonly MigrationItemState[];
  readonly mode: RunMode;
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor>;
  readonly store: typeof MigrationStore.Service;
}

const processTargetedSourceIdentities = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
>({
  counts,
  definition,
  itemStates,
  mode,
  runId,
  source,
  store,
}: ProcessTargetedSourceIdentitiesOptions<
  Source,
  Command,
  PipelineError,
  Cursor
>) =>
  Effect.gen(function* () {
    const sourceIdentities = sourceIdentitiesForMode(
      mode,
      selectBacklogStates(mode, itemStates)
    );

    for (const sourceIdentity of sourceIdentities) {
      const previousState =
        itemStates.find(
          (itemState) => itemState.sourceIdentity === sourceIdentity
        ) ?? null;
      const readByIdentity = source.readByIdentity(sourceIdentity);
      const readByIdentityWithRetry =
        definition.sourceLookupRetry === undefined
          ? readByIdentity
          : definition.sourceLookupRetry(readByIdentity);
      const lookup = yield* readByIdentityWithRetry.pipe(
        Effect.map((sourceItem) =>
          sourceItem === null
            ? ({
                kind: "missing" as const,
                error: new SourcePluginError({
                  message: "Source identity was not found",
                  cause: { sourceIdentity },
                }),
              } as const)
            : ({ kind: "found" as const, sourceItem } as const)
        ),
        Effect.catch((error) =>
          Effect.succeed({ kind: "failed" as const, error } as const)
        )
      );

      if (lookup.kind === "failed" || lookup.kind === "missing") {
        if (previousState === null) {
          return yield* lookup.error;
        }

        yield* store.upsertItemState(
          makeSourceLookupFailedItemState(
            definition.id,
            runId,
            sourceIdentity,
            previousState,
            lookup.error
          )
        );
        counts.failed += 1;
        continue;
      }

      const outcome = yield* processSourceItem({
        definition,
        reprocessUnchangedTerminal: shouldReprocessUnchangedTerminal(mode),
        runId,
        sourceSchema: source.sourceSchema,
        sourceItem: lookup.sourceItem,
      });

      addOutcomeToCounts(counts, outcome);
    }

    return sourceIdentities;
  });

interface ProcessCursorDiscoveryOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<
    Source,
    Command,
    PipelineError,
    Cursor
  >;
  readonly excludedSourceIdentities: readonly SourceIdentity[];
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source, Cursor>;
  readonly store: typeof MigrationStore.Service;
}

const processCursorDiscovery = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
>({
  counts,
  definition,
  excludedSourceIdentities,
  runId,
  source,
  store,
}: ProcessCursorDiscoveryOptions<Source, Command, PipelineError, Cursor>) =>
  Effect.gen(function* () {
    const storedCursor = yield* store.getSourceCursor(definition.id);
    let cursor =
      storedCursor === null
        ? null
        : yield* decodeSourceCursor(source.cursorSchema, storedCursor);
    let committedCursor: Cursor | undefined;

    while (true) {
      const read = source.read(cursor);
      const readWithRetry =
        definition.sourceCursorRetry === undefined
          ? read
          : definition.sourceCursorRetry(read);
      const readResult = yield* readWithRetry;

      for (const sourceItem of readResult.items) {
        if (excludedSourceIdentities.includes(sourceItem.identity)) {
          continue;
        }

        const outcome = yield* processSourceItem({
          definition,
          runId,
          sourceSchema: source.sourceSchema,
          sourceItem,
        });

        addOutcomeToCounts(counts, outcome);
      }

      if (readResult.nextCursor === undefined) {
        break;
      }

      cursor = readResult.nextCursor;
      committedCursor = readResult.nextCursor;
      const encodedCursor = yield* encodeSourceCursor(
        source.cursorSchema,
        readResult.nextCursor
      );
      yield* store.setSourceCursor(definition.id, encodedCursor);
    }

    return committedCursor;
  });

const runMigrationDefinition = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor,
>(
  definition: MigrationDefinition<Source, Command, PipelineError, Cursor>,
  runId: MigrationRunId,
  mode: RunMode
): Effect.Effect<
  MigrationDefinitionRunSummary,
  RunMigrationDefinitionError
> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<Source, Cursor>();
    const store = yield* MigrationStore;

    const counts = { ...emptyCounts };
    const itemStates = yield* store.listItemStates(definition.id);

    const attemptedSourceIdentities = yield* processTargetedSourceIdentities({
      counts,
      definition,
      itemStates,
      mode,
      runId,
      source,
      store,
    });

    if (isTargetedMode(mode)) {
      return {
        definitionId: definition.id,
        status:
          counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
        counts,
      };
    }

    yield* processCursorDiscovery({
      counts,
      definition,
      excludedSourceIdentities: attemptedSourceIdentities,
      runId,
      source,
      store,
    });

    return {
      definitionId: definition.id,
      status: counts.failed > 0 ? ("failed" as const) : ("succeeded" as const),
      counts,
    };
  });
  const layer = Layer.mergeAll(
    definition.source.layer,
    definition.destination.layer,
    definition.store
  );

  return program.pipe(Effect.provide(layer));
};

export const runMigrations = <
  Definitions extends readonly AnyMigrationDefinition[],
>(
  input: RunRequestInput<Definitions>
): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
  const requestEffect = Effect.try({
    try: () => makeRunRequest(input),
    catch: invalidRunRequestError,
  });

  return Effect.flatMap(
    requestEffect,
    (request): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
      const firstDefinition = request.definitions[0];

      if (firstDefinition === undefined) {
        return Effect.fail(emptyRunError);
      }

      const orderedDefinitions = orderDefinitions(
        request.definitions,
        request.definitionIds
      );

      if (orderedDefinitions.kind === "failed") {
        return Effect.fail(orderedDefinitions.error);
      }

      const firstOrderedDefinition = orderedDefinitions.definitions[0];

      if (firstOrderedDefinition === undefined) {
        return Effect.fail(emptyRunError);
      }

      const sharedStoreError = validateSharedStore(
        orderedDefinitions.definitions
      );

      if (sharedStoreError !== null) {
        return Effect.fail(sharedStoreError);
      }

      const definitionIds = orderedDefinitions.definitions.map(
        (definition) => definition.id
      );

      const program = Effect.gen(function* () {
        const store = yield* MigrationStore;
        const runId = yield* store.createRunId;

        return yield* Effect.acquireUseRelease(
          acquireDefinitionLocks(store, runId, definitionIds),
          () =>
            Effect.gen(function* () {
              const runState = yield* store.beginRun(runId, definitionIds);
              const definitionSummaries = yield* Effect.gen(function* () {
                const summaries: MigrationDefinitionRunSummary[] = [];

                for (const definition of orderedDefinitions.definitions) {
                  const summary = yield* runMigrationDefinition(
                    definition,
                    runState.runId,
                    request.mode ?? normalRunMode
                  );
                  summaries.push(summary);
                }

                return summaries;
              }).pipe(
                Effect.catch((error) =>
                  failRunAndRethrow(store, runState.runId, definitionIds, error)
                )
              );

              const runStatus = runStatusForDefinitions(definitionSummaries);
              const completedRun =
                runStatus === "failed"
                  ? yield* store.failRun(runState.runId, definitionIds)
                  : yield* store.completeRun(runState.runId, definitionIds);

              return {
                runId: runState.runId,
                status: runStatus,
                startedAt: runState.startedAt,
                finishedAt: completedRun.finishedAt ?? new Date(),
                definitions: definitionSummaries,
              };
            }),
          (locks, exit) => releaseDefinitionLocks(store, locks, exit)
        );
      });

      return program.pipe(Effect.provide(firstOrderedDefinition.store));
    }
  );
};

export const runMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
  Cursor = unknown,
>(
  definition: MigrationDefinition<Source, Command, PipelineError, Cursor>
): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const definitionIds = [definition.id];
    const runId = yield* store.createRunId;

    return yield* Effect.acquireUseRelease(
      acquireDefinitionLocks(store, runId, definitionIds),
      () =>
        Effect.gen(function* () {
          const runState = yield* store.beginRun(runId, definitionIds);
          const summary = yield* runMigrationDefinition(
            definition,
            runState.runId,
            normalRunMode
          ).pipe(
            Effect.catch((error) =>
              failRunAndRethrow(store, runState.runId, definitionIds, error)
            )
          );
          const completedRun =
            summary.status === "failed"
              ? yield* store.failRun(runState.runId, definitionIds)
              : yield* store.completeRun(runState.runId, definitionIds);

          const runStatus: MigrationRunSummary["status"] =
            summary.status === "failed" ? "failed" : "succeeded";

          return {
            runId: runState.runId,
            status: runStatus,
            startedAt: runState.startedAt,
            finishedAt: completedRun.finishedAt ?? new Date(),
            definitions: [summary],
          };
        }),
      (locks, exit) => releaseDefinitionLocks(store, locks, exit)
    );
  });

  return program.pipe(Effect.provide(definition.store));
};
