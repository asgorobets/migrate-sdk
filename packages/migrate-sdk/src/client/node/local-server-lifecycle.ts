import { Clock, Effect } from "effect";

const defaultInitialConnectionTimeoutMs = 30_000;
const defaultPollIntervalMs = 100;

export interface LocalMigrateServerLifetimeInput {
  readonly clientIds: Effect.Effect<ReadonlySet<number>>;
  readonly hasActiveExecutions: () => boolean;
  readonly initialConnectionTimeoutMs?: number;
  readonly listActiveRuns: Effect.Effect<readonly unknown[], unknown>;
  readonly pollIntervalMs?: number;
}

export const waitForLocalMigrateServerIdle = Effect.fn(
  "MigrateServer.waitForLocalMigrateServerIdle"
)(function* ({
  clientIds,
  hasActiveExecutions,
  initialConnectionTimeoutMs = defaultInitialConnectionTimeoutMs,
  listActiveRuns,
  pollIntervalMs = defaultPollIntervalMs,
}: LocalMigrateServerLifetimeInput) {
  const startedAt = yield* Clock.currentTimeMillis;
  let acceptedClient = false;

  while (true) {
    const connectedClientIds = yield* clientIds;

    if (connectedClientIds.size > 0) {
      acceptedClient = true;
    } else if (!acceptedClient) {
      const now = yield* Clock.currentTimeMillis;

      if (now - startedAt >= initialConnectionTimeoutMs) {
        return;
      }
    } else if (!hasActiveExecutions()) {
      const noActiveRuns = yield* listActiveRuns.pipe(
        Effect.map((activeRuns) => activeRuns.length === 0),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Unable to verify whether detached migration runs remain active; keeping the local Migrate Server available"
          ).pipe(Effect.annotateLogs({ cause }), Effect.as(false))
        )
      );

      if (noActiveRuns) {
        return;
      }
    }

    yield* Effect.sleep(pollIntervalMs);
  }
});
