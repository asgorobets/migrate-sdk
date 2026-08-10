import { Effect } from "effect";
import type { ExecutionStartResult } from "migrate-sdk";

export const completedInlineExecution = <Summary, Error, Requirements>(
  effect: Effect.Effect<ExecutionStartResult<Summary>, Error, Requirements>
): Effect.Effect<Summary, Error, Requirements> =>
  Effect.flatMap(effect, (start) => {
    if (start.kind === "completed") {
      return Effect.succeed(start.summary);
    }

    if (start.handle === undefined) {
      return Effect.die("Inline execution returned a detached run");
    }

    return Effect.flatMap(start.handle.wait, (result) =>
      result.kind === "finished"
        ? Effect.succeed(result.summary)
        : Effect.die(`Inline example execution ended as ${result.kind}`)
    );
  });
