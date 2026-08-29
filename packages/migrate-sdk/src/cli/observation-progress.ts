import { Console, Effect, Option, Ref, Semaphore } from "effect";
import type { MigrateObservationEvent } from "../protocol/index.ts";
import { renderMigrationObservationEvent } from "./render.ts";
import type { MigrationCliRuntimeShape } from "./runtime.ts";

export type CliObservationProgressMode = "auto" | "log" | "none";

type ProgressEvent = Extract<
  MigrateObservationEvent,
  { readonly kind: "progress" }
>;

export interface CliObservationProgressRenderer {
  readonly cleanup: Effect.Effect<void>;
  readonly pause: Effect.Effect<void>;
  readonly render: (event: ProgressEvent) => Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
}

const terminalEraseLine = "\u001B[2K";
const terminalMoveToLineStart = "\r";
const terminalMoveUpOneLine = "\u001B[1A";
const newlinePattern = /\r?\n/;

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

export const makeCliObservationProgressRenderer = (
  mode: CliObservationProgressMode,
  runtime: MigrationCliRuntimeShape
): Effect.Effect<CliObservationProgressRenderer> => {
  if (mode === "none") {
    return Effect.succeed({
      cleanup: Effect.void,
      pause: Effect.void,
      render: () => Effect.void,
      resume: Effect.void,
    });
  }

  return Effect.gen(function* () {
    const terminalSection = yield* Semaphore.make(1);
    const pausedRef = yield* Ref.make(false);
    const pendingEventRef = yield* Ref.make(Option.none<ProgressEvent>());
    let cleanupNow: Effect.Effect<void> = Effect.void;
    let renderNow: (event: ProgressEvent) => Effect.Effect<void>;

    if (
      mode === "auto" &&
      runtime.stdoutIsTTY === true &&
      runtime.writeProgress !== undefined
    ) {
      const writeProgress = runtime.writeProgress;
      const renderedRowsRef = yield* Ref.make(0);
      cleanupNow = Ref.getAndSet(renderedRowsRef, 0).pipe(
        Effect.flatMap((renderedRows) =>
          renderedRows === 0
            ? Effect.void
            : writeProgress(`${clearRenderedRows(renderedRows)}\n`)
        )
      );
      renderNow = (event) =>
        Effect.gen(function* () {
          const rendered = renderMigrationObservationEvent(event, {
            colors: runtime.useColor === true,
          });
          const renderedRows = yield* Ref.get(renderedRowsRef);
          yield* writeProgress(
            `${clearRenderedRows(renderedRows === 0 ? 1 : renderedRows)}${rendered}`
          );
          yield* Ref.set(
            renderedRowsRef,
            countTerminalRows(rendered, runtime.stdoutColumns)
          );
        });
    } else if (mode === "log") {
      renderNow = (event) =>
        Console.log(
          renderMigrationObservationEvent(event, {
            colors: runtime.useColor === true,
          })
        );
    } else {
      renderNow = () => Effect.void;
    }

    const cleanup = terminalSection.withPermit(cleanupNow);
    const pause = terminalSection.withPermit(
      Ref.set(pausedRef, true).pipe(Effect.andThen(cleanupNow))
    );
    const render = (event: ProgressEvent) =>
      terminalSection.withPermit(
        Ref.get(pausedRef).pipe(
          Effect.flatMap((paused) =>
            paused
              ? Ref.set(pendingEventRef, Option.some(event))
              : renderNow(event)
          )
        )
      );
    const resume = terminalSection.withPermit(
      Effect.gen(function* () {
        yield* Ref.set(pausedRef, false);
        const pendingEvent = yield* Ref.getAndSet(
          pendingEventRef,
          Option.none()
        );

        if (Option.isSome(pendingEvent)) {
          yield* renderNow(pendingEvent.value);
        }
      })
    );

    return {
      cleanup,
      pause,
      render,
      resume,
    };
  });
};
