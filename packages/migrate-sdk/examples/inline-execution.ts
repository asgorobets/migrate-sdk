import { Effect } from "effect";
import type { ExecutionStartResult } from "migrate-sdk";

export const completedInlineExecution = <Summary, Error, Requirements>(
  effect: Effect.Effect<ExecutionStartResult<Summary>, Error, Requirements>
): Effect.Effect<Summary, Error, Requirements> =>
  Effect.flatMap(effect, (result) =>
    result.kind === "completed"
      ? Effect.succeed(result.summary)
      : Effect.die("Inline example execution unexpectedly started")
  );
