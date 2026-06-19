import { Console, Effect, Layer, Ref, SubscriptionRef } from "effect";
import {
  initialMigrationProgressState,
  type MigrationDefinitionProgressState,
  type MigrationProgressCounts,
  type MigrationProgressEvent,
  type MigrationProgressState,
  reduceMigrationProgressState,
} from "../domain/progress.ts";
import { MigrationProgress } from "../services/migration-progress.ts";
import type { MigrationCliRuntimeShape } from "./runtime.ts";

export type CliProgressMode = "auto" | "log" | "none";

const terminalEraseLine = "\u001B[2K";
const terminalMoveToLineStart = "\r";
const terminalMoveUpOneLine = "\u001B[1A";
const newlinePattern = /\r?\n/;

const formatCounts = (counts: MigrationProgressCounts): string =>
  `migrated=${counts.migrated} skipped=${counts.skipped} failed=${counts.failed} unchanged=${counts.unchanged} needsUpdate=${counts.needsUpdate}`;

const countProcessedItems = (counts: MigrationProgressCounts): number =>
  counts.migrated +
  counts.skipped +
  counts.failed +
  counts.unchanged +
  counts.needsUpdate;

const countTerminalRows = (
  text: string,
  columns: number | undefined
): number => {
  const lines = text.split(newlinePattern);

  if (columns === undefined || columns <= 0) {
    return lines.length;
  }

  return lines.reduce(
    (rows, line) =>
      rows + 1 + Math.floor(Math.max(line.length - 1, 0) / columns),
    0
  );
};

const clearRenderedRows = (rows: number): string => {
  if (rows <= 0) {
    return "";
  }

  let clear = `${terminalMoveToLineStart}${terminalEraseLine}`;

  for (let row = 1; row < rows; row += 1) {
    clear += `${terminalMoveUpOneLine}${terminalMoveToLineStart}${terminalEraseLine}`;
  }

  return clear;
};

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

const renderInteractiveProgressLine = (
  state: MigrationProgressState
): string | null => {
  if (state.activeDefinitionId === undefined) {
    return null;
  }

  const definition = findDefinitionState(state, state.activeDefinitionId);

  if (definition === undefined) {
    return null;
  }

  return `Migration Progress definition=${definition.definitionId} processed=${countProcessedItems(definition.counts)} sourceCursorWindows=${definition.cursorWindowsCompleted} ${formatCounts(definition.counts)}`;
};

type InteractiveProgressRender =
  | { readonly kind: "cleanup" }
  | { readonly kind: "line"; readonly line: string };

const renderInteractiveProgress = (
  event: MigrationProgressEvent,
  state: MigrationProgressState
): InteractiveProgressRender | null => {
  if (event.kind === "run-completed" || event.kind === "run-failed") {
    return { kind: "cleanup" };
  }

  const line = renderInteractiveProgressLine(state);

  return line === null ? null : { kind: "line", line };
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

const makeInteractiveProgressLayer = (
  writeProgress: NonNullable<MigrationCliRuntimeShape["writeProgress"]>,
  columns: number | undefined
) =>
  Layer.effect(
    MigrationProgress,
    Effect.gen(function* () {
      const stateRef = yield* SubscriptionRef.make(
        initialMigrationProgressState
      );
      const renderedRowsRef = yield* Ref.make(0);
      const cleanupRenderedProgress = Ref.getAndSet(renderedRowsRef, 0).pipe(
        Effect.flatMap((renderedRows) =>
          renderedRows === 0
            ? Effect.void
            : writeProgress(`${clearRenderedRows(renderedRows)}\n`)
        )
      );
      const writeRenderedLine = (line: string) =>
        Effect.gen(function* () {
          const renderedRows = yield* Ref.get(renderedRowsRef);
          yield* writeProgress(
            `${clearRenderedRows(renderedRows === 0 ? 1 : renderedRows)}${line}`
          );
          yield* Ref.set(renderedRowsRef, countTerminalRows(line, columns));
        });

      yield* Effect.addFinalizer(() => cleanupRenderedProgress);

      return {
        emit: (event) =>
          SubscriptionRef.modify(stateRef, (state) => {
            const nextState = reduceMigrationProgressState(state, event);

            return [
              renderInteractiveProgress(event, nextState),
              nextState,
            ] as const;
          }).pipe(
            Effect.flatMap((render) => {
              if (render === null) {
                return Effect.void;
              }

              return render.kind === "cleanup"
                ? cleanupRenderedProgress
                : writeRenderedLine(render.line);
            })
          ),
      };
    })
  );

export const makeCliProgressLayer = (
  mode: CliProgressMode,
  runtime: MigrationCliRuntimeShape
): Layer.Layer<MigrationProgress> => {
  if (mode === "log") {
    return logProgressLayer;
  }

  if (
    mode === "auto" &&
    runtime.stdoutIsTTY === true &&
    runtime.writeProgress !== undefined
  ) {
    return makeInteractiveProgressLayer(
      runtime.writeProgress,
      runtime.stdoutColumns
    );
  }

  return MigrationProgress.noopLayer;
};
