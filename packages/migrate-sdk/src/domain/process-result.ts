import { Schema } from "effect";

/** A normal pipeline result indicating that this item should not be migrated. */
export const SkipItem = Schema.Struct({
  kind: Schema.Literal("skipped"),
  reason: Schema.String,
});
export type SkipItem = typeof SkipItem.Type;

/** Returning void completes processing; returning SkipItem records a skip. */
// biome-ignore lint/suspicious/noConfusingVoidType: Existing pipelines and Effect.void return void, not undefined.
export type ProcessResult = void | SkipItem;

// Schema.Void discards arbitrary values; completion must be exactly undefined.
export const ProcessResultSchema = Schema.Union([Schema.Undefined, SkipItem]);

/** Return this value from the pipeline; it does not short-circuit nested callers. */
export const skipItem = (reason: string): SkipItem => ({
  kind: "skipped",
  reason,
});

export const makeSkipItem = skipItem;
