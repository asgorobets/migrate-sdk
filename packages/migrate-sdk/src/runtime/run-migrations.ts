import { Effect, Layer } from "effect";
import type { MigrationDefinition } from "../domain/definition.ts";
import type { DestinationCommand } from "../domain/destination.ts";
import { MigrationRuntimeError, SourcePluginError } from "../domain/errors.ts";
import type {
  MigrationDefinitionId,
  MigrationRunId,
  SourceCursor,
  SourceIdentity,
} from "../domain/ids.ts";
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
import {
  type ProcessSourceItemError,
  processSourceItem,
} from "./process-source-item.ts";

export type RunMigrationDefinitionError =
  | SourcePluginError
  | ProcessSourceItemError;

export type RunMigrationError =
  | MigrationRuntimeError
  | RunMigrationDefinitionError;

const emptyRunError = new MigrationRuntimeError({
  message: "Run request must include at least one Migration Definition",
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
  previousState: MigrationItemState | null,
  error: unknown
): FailedItemState => ({
  definitionId,
  sourceIdentity,
  ...(previousState?.sourceVersion === undefined
    ? {}
    : { sourceVersion: previousState.sourceVersion }),
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
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<Source, Command, PipelineError>;
  readonly itemStates: readonly MigrationItemState[];
  readonly mode: RunMode;
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source>;
  readonly store: typeof MigrationStore.Service;
}

const processTargetedSourceIdentities = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>({
  counts,
  definition,
  itemStates,
  mode,
  runId,
  source,
  store,
}: ProcessTargetedSourceIdentitiesOptions<Source, Command, PipelineError>) =>
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
      const lookup = yield* source.readByIdentity(sourceIdentity).pipe(
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
> {
  readonly counts: MutableDefinitionCounts;
  readonly definition: MigrationDefinition<Source, Command, PipelineError>;
  readonly excludedSourceIdentities: readonly SourceIdentity[];
  readonly runId: MigrationRunId;
  readonly source: SourcePlugin<Source>;
  readonly store: typeof MigrationStore.Service;
}

const processCursorDiscovery = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>({
  counts,
  definition,
  excludedSourceIdentities,
  runId,
  source,
  store,
}: ProcessCursorDiscoveryOptions<Source, Command, PipelineError>) =>
  Effect.gen(function* () {
    let cursor = yield* store.getSourceCursor(definition.id);
    let committedCursor: SourceCursor | undefined;

    while (true) {
      const readResult = yield* source.read(cursor);

      for (const sourceItem of readResult.items) {
        if (excludedSourceIdentities.includes(sourceItem.identity)) {
          continue;
        }

        const outcome = yield* processSourceItem({
          definition,
          runId,
          sourceItem,
        });

        addOutcomeToCounts(counts, outcome);
      }

      if (readResult.nextCursor === undefined) {
        break;
      }

      cursor = readResult.nextCursor;
      committedCursor = readResult.nextCursor;
      yield* store.setSourceCursor(definition.id, readResult.nextCursor);
    }

    return committedCursor;
  });

const runMigrationDefinition = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>(
  definition: MigrationDefinition<Source, Command, PipelineError>,
  runId: MigrationRunId,
  mode: RunMode
): Effect.Effect<
  MigrationDefinitionRunSummary,
  RunMigrationDefinitionError
> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<Source>();
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

    const committedCursor = yield* processCursorDiscovery({
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
      ...(committedCursor === undefined ? {} : { cursor: committedCursor }),
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
  const request = makeRunRequest(input);
  const firstDefinition = request.definitions[0];

  if (firstDefinition === undefined) {
    return Effect.fail(emptyRunError);
  }

  const definitionIds = request.definitions.map((definition) => definition.id);

  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runState = yield* store.beginRun(definitionIds);
    const definitionSummaries: MigrationDefinitionRunSummary[] = [];

    for (const definition of request.definitions) {
      const summary = yield* runMigrationDefinition(
        definition,
        runState.runId,
        request.mode ?? normalRunMode
      );
      definitionSummaries.push(summary);
    }

    const runStatus = runStatusForDefinitions(definitionSummaries);
    const completedRun =
      runStatus === "failed"
        ? yield* store.failRun(runState.runId)
        : yield* store.completeRun(runState.runId);

    return {
      runId: runState.runId,
      status: runStatus,
      startedAt: runState.startedAt,
      finishedAt: completedRun.finishedAt ?? new Date(),
      definitions: definitionSummaries,
    };
  });

  return program.pipe(Effect.provide(firstDefinition.store));
};

export const runMigration = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>(
  definition: MigrationDefinition<Source, Command, PipelineError>
): Effect.Effect<MigrationRunSummary, RunMigrationError> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runState = yield* store.beginRun([definition.id]);
    const summary = yield* runMigrationDefinition(
      definition,
      runState.runId,
      normalRunMode
    );
    const completedRun =
      summary.status === "failed"
        ? yield* store.failRun(runState.runId)
        : yield* store.completeRun(runState.runId);

    const runStatus: MigrationRunSummary["status"] =
      summary.status === "failed" ? "failed" : "succeeded";

    return {
      runId: runState.runId,
      status: runStatus,
      startedAt: runState.startedAt,
      finishedAt: completedRun.finishedAt ?? new Date(),
      definitions: [summary],
    };
  });

  return program.pipe(Effect.provide(definition.store));
};
