import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  DestinationJournal,
  DestinationJournalExtension,
  toMigrationRunId,
} from "migrate-sdk";

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

  it.effect("lets an extension decode its own typed journal value", () =>
    Effect.gen(function* () {
      const importOperation = DestinationJournalExtension.make(
        "commercetools.product-draft.import-operation@v1",
        Schema.Struct({
          operationId: Schema.String,
          state: Schema.Literal("processing"),
        })
      );
      const journal = {
        extensions: {
          [importOperation.id]: {
            operationId: "operation-1",
            state: "processing",
          },
        },
        process: {
          entries: [],
          runId: toMigrationRunId("run-process"),
        },
        rollbackAttempts: [],
      };

      const decoded =
        yield* Schema.decodeUnknownEffect(DestinationJournal)(journal);
      const value = yield* importOperation.read(decoded);

      expect(value).toEqual({
        operationId: "operation-1",
        state: "processing",
      });
    })
  );
});
