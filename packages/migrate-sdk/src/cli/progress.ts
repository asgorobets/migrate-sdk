import { Console, Effect, Layer, Ref, SubscriptionRef } from "effect";
import {
  initialMigrationProgressState,
  type MigrationDefinitionProgressState,
  type MigrationProgressCounts,
  type MigrationProgressEvent,
  type MigrationProgressState,
  reduceMigrationProgressState,
} from "../domain/progress.ts";
import {
  initialRollbackProgressState,
  type RollbackDefinitionProgressState,
  type RollbackProgressCounts,
  type RollbackProgressEvent,
  type RollbackProgressState,
  reduceRollbackProgressState,
} from "../domain/rollback-progress.ts";
import { MigrationProgress } from "../services/migration-progress.ts";
import { RollbackProgress } from "../services/rollback-progress.ts";
import type { MigrationCliRuntimeShape } from "./runtime.ts";

export type CliProgressMode = "auto" | "log" | "none";

const terminalEraseLine = "\u001B[2K";
const terminalMoveToLineStart = "\r";
const terminalMoveUpOneLine = "\u001B[1A";
const newlinePattern = /\r?\n/;
const progressBarWidth = 20;

const formatCounts = (counts: MigrationProgressCounts): string =>
  `migrated=${counts.migrated} skipped=${counts.skipped} failed=${counts.failed} unchanged=${counts.unchanged} needsUpdate=${counts.needsUpdate}`;

const formatRollbackCounts = (counts: RollbackProgressCounts): string =>
  `rolledBack=${counts.rolledBack} skipped=${counts.skipped} failed=${counts.failed}`;

const countProcessedItems = (counts: MigrationProgressCounts): number =>
  counts.migrated +
  counts.skipped +
  counts.failed +
  counts.unchanged +
  counts.needsUpdate;

const percentageForKnownTotal = (processed: number, total: number): number => {
  if (total === 0) {
    return 100;
  }

  return Math.min(100, Math.round((Math.min(processed, total) / total) * 100));
};

const renderProgressBar = (percentage: number): string => {
  const filled = Math.round((percentage / 100) * progressBarWidth);

  return `[${"#".repeat(filled)}${"-".repeat(progressBarWidth - filled)}]`;
};

const formatKnownTotalProgress = (processed: number, total: number): string => {
  const percentage = percentageForKnownTotal(processed, total);

  return `progress=${renderProgressBar(percentage)} processed=${processed} total=${total} percentage=${percentage}%`;
};

const formatLowerBoundTotalProgress = (
  processed: number,
  minimum: number
): string => `processed=${processed} total=${minimum}+`;

const formatInteractiveProcessedItems = (
  definition: MigrationDefinitionProgressState
): string => {
  const processed = countProcessedItems(definition.counts);
  const total = definition.sourceItemTotal;

  switch (total?.kind) {
    case "known":
      return formatKnownTotalProgress(processed, total.count);
    case "lower-bound":
      return formatLowerBoundTotalProgress(processed, total.minimum);
    default:
      return `processed=${processed}`;
  }
};

const formatLogTotalProgress = (
  definition: MigrationDefinitionProgressState | undefined,
  processed: number
): string => {
  const total = definition?.sourceItemTotal;

  switch (total?.kind) {
    case "known":
      return ` ${formatKnownTotalProgress(processed, total.count)}`;
    case "lower-bound":
      return ` ${formatLowerBoundTotalProgress(processed, total.minimum)}`;
    default:
      return "";
  }
};

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

const findRollbackDefinitionState = (
  state: RollbackProgressState,
  definitionId: string
): RollbackDefinitionProgressState | undefined =>
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
    case "source-item-total-counted":
      switch (event.sourceItemTotal.kind) {
        case "known":
          return `[progress] Source Item total counted definition=${event.definitionId} total=${event.sourceItemTotal.count}`;
        case "lower-bound":
          return `[progress] Source Item total counted definition=${event.definitionId} total=${event.sourceItemTotal.minimum}+ reason=${event.sourceItemTotal.reason}`;
        case "unknown":
          return null;
        default: {
          const exhaustive: never = event.sourceItemTotal;
          return exhaustive;
        }
      }
    case "source-item-completed":
      return null;
    case "source-cursor-window-completed": {
      const definition = findDefinitionState(state, event.definitionId);
      const itemsRead = definition?.itemsRead ?? event.itemsRead;
      const processed =
        definition === undefined
          ? countProcessedItems(event.counts)
          : countProcessedItems(definition.counts);

      return `[progress] Source Cursor Window completed definition=${event.definitionId} itemsRead=${itemsRead}${formatLogTotalProgress(definition, processed)} ${formatCounts(event.counts)}`;
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

const renderRollbackProgressLogLine = (
  event: RollbackProgressEvent
): string | null => {
  switch (event.kind) {
    case "rollback-started":
      return `[progress] Rollback started definitions=${event.definitionIds.join(",")}`;
    case "definition-started":
      return `[progress] Rollback Definition started definition=${event.definitionId}`;
    case "source-item-completed":
      return `[progress] Rollback Source Item completed definition=${event.definitionId} ${formatRollbackCounts(event.counts)}`;
    case "definition-completed":
      return `[progress] Rollback Definition completed definition=${event.definitionId} status=${event.status} ${formatRollbackCounts(event.counts)}`;
    case "rollback-completed":
      return `[progress] Rollback completed status=${event.status} definitions=${event.definitionIds.join(",")}`;
    case "rollback-failed":
      return `[progress] Rollback failed definitions=${event.definitionIds.join(",")}`;
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

  return `Migration Progress definition=${definition.definitionId} ${formatInteractiveProcessedItems(definition)} sourceCursorWindows=${definition.cursorWindowsCompleted} ${formatCounts(definition.counts)}`;
};

const renderInteractiveRollbackProgressLine = (
  state: RollbackProgressState
): string | null => {
  if (state.activeDefinitionId === undefined) {
    return null;
  }

  const definition = findRollbackDefinitionState(
    state,
    state.activeDefinitionId
  );

  if (definition === undefined) {
    return null;
  }

  return `Rollback Progress definition=${definition.definitionId} processed=${definition.itemsProcessed} ${formatRollbackCounts(definition.counts)}`;
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

const renderInteractiveRollbackProgress = (
  event: RollbackProgressEvent,
  state: RollbackProgressState
): InteractiveProgressRender | null => {
  if (event.kind === "rollback-completed" || event.kind === "rollback-failed") {
    return { kind: "cleanup" };
  }

  const line = renderInteractiveRollbackProgressLine(state);

  return line === null ? null : { kind: "line", line };
};

const logProgressLayer = Layer.effect(
  MigrationProgress,
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initialMigrationProgressState);

    return {
      countSourceItemTotals: true,
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

const rollbackLogProgressLayer = Layer.effect(
  RollbackProgress,
  Effect.gen(function* () {
    const stateRef = yield* SubscriptionRef.make(initialRollbackProgressState);

    return {
      emit: (event) =>
        SubscriptionRef.update(stateRef, (state) =>
          reduceRollbackProgressState(state, event)
        ).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              const line = renderRollbackProgressLogLine(event);

              return line === null ? Effect.void : Console.log(line);
            })
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
        countSourceItemTotals: true,
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

const makeInteractiveRollbackProgressLayer = (
  writeProgress: NonNullable<MigrationCliRuntimeShape["writeProgress"]>,
  columns: number | undefined
) =>
  Layer.effect(
    RollbackProgress,
    Effect.gen(function* () {
      const stateRef = yield* SubscriptionRef.make(
        initialRollbackProgressState
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
            const nextState = reduceRollbackProgressState(state, event);

            return [
              renderInteractiveRollbackProgress(event, nextState),
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

export const makeCliRollbackProgressLayer = (
  mode: CliProgressMode,
  runtime: MigrationCliRuntimeShape
): Layer.Layer<RollbackProgress> => {
  if (mode === "log") {
    return rollbackLogProgressLayer;
  }

  if (
    mode === "auto" &&
    runtime.stdoutIsTTY === true &&
    runtime.writeProgress !== undefined
  ) {
    return makeInteractiveRollbackProgressLayer(
      runtime.writeProgress,
      runtime.stdoutColumns
    );
  }

  return RollbackProgress.noopLayer;
};
