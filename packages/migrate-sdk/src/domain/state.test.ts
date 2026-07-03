import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  SourceIdentityContractFingerprint,
  SourceIdentityContractId,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "./ids.ts";
import {
  type MigrationItemState,
  type MigrationItemStateForTrackingContract,
  makeMigrationItemStateWithTrackingRecordSchema,
} from "./state.ts";

const ArticleViewsTrackingRecord = Schema.Struct({
  entryId: Schema.String,
  views: Schema.NumberFromString,
});
type ArticleViewsTrackingRecord = typeof ArticleViewsTrackingRecord.Type;

describe("MigrationItemState", () => {
  it.effect(
    "decodes tracking records through a composed item state schema",
    () =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(
          makeMigrationItemStateWithTrackingRecordSchema(
            ArticleViewsTrackingRecord
          )
        )({
          definitionId: toMigrationDefinitionId("articles"),
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: {
            encoded: toEncodedSourceIdentity("article-1"),
            fingerprint:
              SourceIdentityContractFingerprint.make("article-source"),
            id: SourceIdentityContractId.make("article-id"),
            key: "article-1",
          },
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          trackingRecord: {
            entryId: "entry-1",
            views: "42",
          },
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });

        expect(decoded.trackingRecord).toEqual({
          entryId: "entry-1",
          views: 42,
        });
      })
  );

  it("types composed item state tracking records from the tracking schema", () => {
    const itemStateSchema = makeMigrationItemStateWithTrackingRecordSchema(
      ArticleViewsTrackingRecord
    );
    type ItemState = typeof itemStateSchema.Type;

    expectTypeOf<ItemState["trackingRecord"]>().toEqualTypeOf<
      ArticleViewsTrackingRecord | undefined
    >();
    expect(itemStateSchema).toBeDefined();
  });

  it("keeps untracked item state on the base state type", () => {
    expectTypeOf<
      MigrationItemStateForTrackingContract<undefined>
    >().toEqualTypeOf<MigrationItemState>();
  });
});
