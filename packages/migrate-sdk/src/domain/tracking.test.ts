import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { DestinationJournal, toMigrationRunId, Tracking } from "migrate-sdk";

type AmbientTrackingContext =
  typeof Tracking.currentContext extends Effect.Effect<
    infer Context,
    infer _E,
    infer _R
  >
    ? Context
    : never;

describe("destination journal public API", () => {
  it.effect("decodes rollback attempt timestamps as runtime Dates", () =>
    Effect.gen(function* () {
      const failedAt = new Date("2026-01-01T00:00:03.000Z");
      const journal = {
        process: {
          entries: [],
          runId: toMigrationRunId("run-process"),
        },
        rollbackAttempts: [
          {
            entries: [],
            error: {
              errorTag: "RollbackFailureTestError",
              kind: "process" as const,
              message: "Rollback failed",
            },
            failedAt,
            runId: toMigrationRunId("run-rollback"),
          },
        ],
      };

      const decoded =
        yield* Schema.decodeUnknownEffect(DestinationJournal)(journal);

      expect(decoded).toEqual(journal);
      expect(decoded.rollbackAttempts[0]?.failedAt).toBeInstanceOf(Date);
    })
  );
});

describe("Tracking", () => {
  it("keeps previous state out of the ambient tracking context", () => {
    const context = {} as AmbientTrackingContext;
    // @ts-expect-error previous state is only available on process and rollback arguments.
    const previousState = context.previousState;

    expect(previousState).toBeUndefined();
  });
});
