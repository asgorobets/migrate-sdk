import { Effect } from "effect";
import type { MigrationRunId, MigrationRunState } from "migrate-sdk";

export const isTerminalRunState = (state: MigrationRunState): boolean =>
  state.finishedAt !== undefined &&
  (state.status === "cancelled" ||
    state.status === "failed" ||
    state.status === "start-failed" ||
    state.status === "succeeded");

export const waitForDurableRunState = <Error, Requirements>({
  pollIntervalMs,
  readRunState,
  runId,
}: {
  readonly pollIntervalMs: number;
  readonly readRunState: Effect.Effect<
    MigrationRunState | null,
    Error,
    Requirements
  >;
  readonly runId: MigrationRunId;
}): Effect.Effect<MigrationRunState, Error, Requirements> =>
  Effect.gen(function* () {
    while (true) {
      const state = yield* readRunState;

      if (state?.runId === runId && isTerminalRunState(state)) {
        return state;
      }

      yield* Effect.sleep(pollIntervalMs);
    }
  });
