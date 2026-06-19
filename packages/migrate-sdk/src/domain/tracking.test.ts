import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { DestinationJournal, toMigrationRunId } from "migrate-sdk";

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
