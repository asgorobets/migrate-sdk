import { Effect, Layer } from "effect";
import type { MigrationDefinition } from "../domain/definition.ts";
import type { DestinationCommand } from "../domain/destination.ts";
import {
  MigrationRuntimeError,
  type MigrationStoreError,
  type SourcePluginError,
} from "../domain/errors.ts";
import type { MigrationRunId, SourceCursor } from "../domain/ids.ts";
import type {
  AnyMigrationDefinition,
  MigrationDefinitionPipelineError,
  MigrationDefinitionRunSummary,
  MigrationRunSummary,
  RunRequestInput,
} from "../domain/run.ts";
import { makeRunRequest } from "../domain/run.ts";
import { MigrationStore } from "../services/migration-store.ts";
import { getSourcePlugin } from "../services/source-plugin.ts";
import {
  type ProcessSourceItemError,
  processSourceItem,
} from "./process-source-item.ts";

export type RunMigrationDefinitionError<PipelineError> =
  | SourcePluginError
  | ProcessSourceItemError<PipelineError>;

export type RunMigrationError<PipelineError> =
  | MigrationRuntimeError
  | MigrationStoreError
  | RunMigrationDefinitionError<PipelineError>;

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

const runMigrationDefinition = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>(
  definition: MigrationDefinition<Source, Command, PipelineError>,
  runId: MigrationRunId
): Effect.Effect<
  MigrationDefinitionRunSummary,
  RunMigrationDefinitionError<PipelineError>
> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<Source>();
    const store = yield* MigrationStore;
    const counts = { ...emptyCounts };
    let cursor = yield* store.getSourceCursor(definition.id);
    let committedCursor: SourceCursor | undefined;

    while (true) {
      const readResult = yield* source.read(cursor);

      for (const sourceItem of readResult.items) {
        const outcome = yield* processSourceItem({
          definition,
          runId,
          sourceItem,
        });

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
            throw new Error(
              `Unhandled Migration Item Outcome: ${unhandledOutcome}`
            );
          }
        }
      }

      if (readResult.nextCursor === undefined) {
        break;
      }

      cursor = readResult.nextCursor;
      committedCursor = readResult.nextCursor;
      yield* store.setSourceCursor(definition.id, readResult.nextCursor);
    }

    return {
      definitionId: definition.id,
      status: "succeeded" as const,
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
): Effect.Effect<
  MigrationRunSummary,
  RunMigrationError<MigrationDefinitionPipelineError<Definitions[number]>>
> => {
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
      const summary = yield* runMigrationDefinition(definition, runState.runId);
      definitionSummaries.push(summary);
    }

    const completedRun = yield* store.completeRun(runState.runId);

    return {
      runId: runState.runId,
      status: "succeeded" as const,
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
): Effect.Effect<MigrationRunSummary, RunMigrationError<PipelineError>> => {
  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runState = yield* store.beginRun([definition.id]);
    const summary = yield* runMigrationDefinition(definition, runState.runId);
    const completedRun = yield* store.completeRun(runState.runId);

    return {
      runId: runState.runId,
      status: "succeeded" as const,
      startedAt: runState.startedAt,
      finishedAt: completedRun.finishedAt ?? new Date(),
      definitions: [summary],
    };
  });

  return program.pipe(Effect.provide(definition.store));
};
