import { Effect } from "effect";
import type {
  DestinationCommand,
  DestinationCommandContext,
} from "../domain/destination.ts";
import type { MigrationDefinition } from "../domain/definition.ts";
import type { MigrationRunId } from "../domain/ids.ts";
import type { PipelineContext } from "../domain/pipeline.ts";
import type { SourceItem } from "../domain/source.ts";
import type { MigratedItemState, MigrationItemOutcome } from "../domain/state.ts";
import { DestinationPlugin } from "../services/destination-plugin.ts";
import { MigrationStore } from "../services/migration-store.ts";

export interface ProcessSourceItemOptions<Source, Command extends DestinationCommand> {
  readonly definition: MigrationDefinition<Source, Command>;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<Source>;
}

export const processSourceItem = <Source, Command extends DestinationCommand>({
  definition,
  runId,
  sourceItem,
}: ProcessSourceItemOptions<
  Source,
  Command
>): Effect.Effect<MigrationItemOutcome, unknown, DestinationPlugin | MigrationStore> =>
  Effect.gen(function* () {
    const destination = yield* DestinationPlugin;
    const store = yield* MigrationStore;
    const previousState = yield* store.getItemState(
      definition.id,
      sourceItem.identity
    );

    const pipelineContext: PipelineContext = {
      definitionId: definition.id,
      runId,
      ...(previousState === null ? {} : { previousState }),
    };

    const command = yield* definition.pipeline(sourceItem, pipelineContext);

    const destinationContext: DestinationCommandContext = {
      definitionId: definition.id,
      runId,
      sourceIdentity: sourceItem.identity,
      ...(sourceItem.version === undefined
        ? {}
        : { sourceVersion: sourceItem.version }),
      ...(previousState === null ? {} : { previousState }),
    };

    const result = yield* destination.execute(command, destinationContext);

    const itemState: MigratedItemState = {
      definitionId: definition.id,
      sourceIdentity: sourceItem.identity,
      ...(sourceItem.version === undefined
        ? {}
        : { sourceVersion: sourceItem.version }),
      lastRunId: runId,
      updatedAt: new Date(),
      status: "migrated",
      destinationIdentity: result.destinationIdentity,
      ...(result.destinationVersion === undefined
        ? {}
        : { destinationVersion: result.destinationVersion }),
    };

    yield* store.upsertItemState(itemState);

    return "migrated" as const;
  });
