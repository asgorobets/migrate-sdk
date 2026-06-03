import { Effect, Layer } from "effect";
import type { DestinationCommand } from "../domain/destination.ts";
import type { MigrationDefinition } from "../domain/definition.ts";
import { MigrationRuntimeError } from "../domain/errors.ts";
import type { MigrationRunId } from "../domain/ids.ts";
import type {
  MigrationDefinitionRunSummary,
  MigrationRunSummary,
  RunRequestInput,
} from "../domain/run.ts";
import { makeRunRequest } from "../domain/run.ts";
import { MigrationStore } from "../services/migration-store.ts";
import { getSourcePlugin } from "../services/source-plugin.ts";
import { processSourceItem } from "./process-source-item.ts";

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

const runMigrationDefinition = <Source, Command extends DestinationCommand>(
  definition: MigrationDefinition<Source, Command>,
  runId: MigrationRunId
): Effect.Effect<MigrationDefinitionRunSummary, unknown> => {
  const program = Effect.gen(function* () {
    const source = yield* getSourcePlugin<Source>();
    const store = yield* MigrationStore;
    const cursor = yield* store.getSourceCursor(definition.id);
    const readResult = yield* source.read(cursor);
    let migrated = 0;

    for (const sourceItem of readResult.items) {
      const outcome = yield* processSourceItem({
        definition,
        runId,
        sourceItem,
      });

      if (outcome === "migrated") {
        migrated += 1;
      }
    }

    if (readResult.nextCursor !== undefined) {
      yield* store.setSourceCursor(definition.id, readResult.nextCursor);
    }

    return {
      definitionId: definition.id,
      status: "succeeded" as const,
      counts: {
        ...emptyCounts,
        migrated,
      },
      ...(readResult.nextCursor === undefined
        ? {}
        : { cursor: readResult.nextCursor }),
    };
  });
  const layer = Layer.mergeAll(
    definition.source.layer,
    definition.destination.layer,
    definition.store
  );

  return program.pipe(Effect.provide(layer));
};

export const runMigrations = (
  input: RunRequestInput
): Effect.Effect<MigrationRunSummary, unknown> => {
  const request = makeRunRequest(input);
  const firstDefinition = request.definitions[0];

  if (firstDefinition === undefined) {
    return Effect.fail(emptyRunError);
  }

  const definitionIds = request.definitions.map((definition) => definition.id);

  const program = Effect.gen(function* () {
    const store = yield* MigrationStore;
    const runState = yield* store.beginRun(definitionIds);
    const definitionSummaries: Array<MigrationDefinitionRunSummary> = [];

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

export const runMigration = <Source, Command extends DestinationCommand>(
  definition: MigrationDefinition<Source, Command>
): Effect.Effect<MigrationRunSummary, unknown> =>
  runMigrations({ definitions: [definition] });
