import { Effect } from "effect";
import type { MigrationDefinition } from "../domain/definition.ts";
import type {
  DestinationCommand,
  DestinationCommandContext,
} from "../domain/destination.ts";
import type {
  DestinationPluginError,
  MigrationStoreError,
} from "../domain/errors.ts";
import type { MigrationRunId } from "../domain/ids.ts";
import type { PipelineContext } from "../domain/pipeline.ts";
import type { SourceItem } from "../domain/source.ts";
import type {
  MigratedItemState,
  MigrationItemOutcome,
  MigrationItemState,
} from "../domain/state.ts";
import { DestinationPlugin } from "../services/destination-plugin.ts";
import { MigrationStore } from "../services/migration-store.ts";

export interface ProcessSourceItemOptions<
  Source,
  Command extends DestinationCommand,
  PipelineError,
> {
  readonly definition: MigrationDefinition<Source, Command, PipelineError>;
  readonly runId: MigrationRunId;
  readonly sourceItem: SourceItem<Source>;
}

export type ProcessSourceItemError<PipelineError> =
  | DestinationPluginError
  | MigrationStoreError
  | PipelineError;

const isUnchangedTerminalState = <Source>(
  previousState: MigrationItemState | null,
  sourceItem: SourceItem<Source>
): boolean =>
  (previousState?.status === "migrated" ||
    previousState?.status === "skipped") &&
  previousState.sourceVersion === sourceItem.version;

export const processSourceItem = <
  Source,
  Command extends DestinationCommand,
  PipelineError,
>({
  definition,
  runId,
  sourceItem,
}: ProcessSourceItemOptions<Source, Command, PipelineError>): Effect.Effect<
  MigrationItemOutcome,
  ProcessSourceItemError<PipelineError>,
  DestinationPlugin | MigrationStore
> =>
  Effect.gen(function* () {
    const destination = yield* DestinationPlugin;
    const store = yield* MigrationStore;
    const previousState = yield* store.getItemState(
      definition.id,
      sourceItem.identity
    );

    if (isUnchangedTerminalState(previousState, sourceItem)) {
      return "unchanged" as const;
    }

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
