import { Console, Effect, Layer, SubscriptionRef } from "effect";
import {
  initialMigrationProgressState,
  type MigrationDefinitionProgressState,
  type MigrationProgressCounts,
  type MigrationProgressEvent,
  type MigrationProgressState,
  reduceMigrationProgressState,
} from "../domain/progress.ts";
import { MigrationProgress } from "../services/migration-progress.ts";

export type CliProgressMode = "auto" | "log" | "none";

const formatCounts = (counts: MigrationProgressCounts): string =>
  `migrated=${counts.migrated} skipped=${counts.skipped} failed=${counts.failed} unchanged=${counts.unchanged} needsUpdate=${counts.needsUpdate}`;

const findDefinitionState = (
  state: MigrationProgressState,
  definitionId: string
): MigrationDefinitionProgressState | undefined =>
  state.definitions.find(
    (definition) => definition.definitionId === definitionId
  );

const renderProgressLogLine = (
  event: MigrationProgressEvent,
  state: MigrationProgressState
): string | null => {
  switch (event.kind) {
    case "run-started":
      return `[progress] Run started definitions=${event.definitionIds.join(",")}`;
    case "definition-started":
      return `[progress] Definition started definition=${event.definitionId}`;
    case "source-item-completed":
      return null;
    case "source-cursor-window-completed": {
      const definition = findDefinitionState(state, event.definitionId);
      const itemsRead = definition?.itemsRead ?? event.itemsRead;

      return `[progress] Source Cursor Window completed definition=${event.definitionId} itemsRead=${itemsRead} ${formatCounts(event.counts)}`;
    }
    case "definition-completed":
      return `[progress] Definition completed definition=${event.definitionId} status=${event.status} ${formatCounts(event.counts)}`;
    case "run-completed":
      return `[progress] Run completed status=${event.status} definitions=${event.definitionIds.join(",")}`;
    case "run-failed":
      return `[progress] Run failed definitions=${event.definitionIds.join(",")}`;
    default:
      return null;
  }
};

const logProgressLayer = Layer.effect(
  MigrationProgress,
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initialMigrationProgressState);

    return {
      emit: (event) =>
        SubscriptionRef.modify(stateRef, (state) => {
          const nextState = reduceMigrationProgressState(state, event);

          return [renderProgressLogLine(event, nextState), nextState] as const;
        }).pipe(
          Effect.flatMap((line) =>
            line === null ? Effect.void : Console.log(line)
          )
        ),
    };
  })
);

export const makeCliProgressLayer = (
  mode: CliProgressMode
): Layer.Layer<MigrationProgress> =>
  mode === "log" ? logProgressLayer : MigrationProgress.noopLayer;
