import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  type ConfiguredSource,
  MigrationDefinition,
  type MigrationDefinitionInput,
  type MigrationStore,
  type MigrationStoreError,
  type TrackingRecord,
  TrackingRecordContract,
} from "migrate-sdk";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;

const ArticleTrackingRecord = Schema.Struct({
  entryId: Schema.String,
  locale: Schema.String,
});
type ArticleTrackingRecord = typeof ArticleTrackingRecord.Type;

const source = {} as ConfiguredSource<ArticleSource, unknown, string>;
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;
const articleTracking = TrackingRecordContract.make({
  id: "article-tracking",
  schema: ArticleTrackingRecord,
});

describe("MigrationDefinition", () => {
  it("requires the tracking contract on tracked definition inputs", () => {
    const trackedDefinitionMissingTrackingInput = {
      id: "articles",
      source,
      store,
      process: () => Effect.void,
    };
    // @ts-expect-error tracked definition inputs must provide the tracking contract.
    const trackedDefinitionMissingTracking: MigrationDefinitionInput<
      ArticleSource,
      never,
      unknown,
      string,
      never,
      ArticleSource,
      never,
      never,
      typeof articleTracking
    > = trackedDefinitionMissingTrackingInput;

    expect(trackedDefinitionMissingTracking).toBe(
      trackedDefinitionMissingTrackingInput
    );
  });

  it("types process previous state with the definition tracking record contract", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      tracking: articleTracking,
      process: (_source, context) => {
        expectTypeOf(context.previousState?.trackingRecord).toEqualTypeOf<
          ArticleTrackingRecord | undefined
        >();
        return Effect.void;
      },
    });

    expect(definition.process).toBeDefined();
  });

  it("keeps untracked process previous state on the generic tracking record type", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      process: (_source, context) => {
        expectTypeOf(context.previousState?.trackingRecord).toEqualTypeOf<
          TrackingRecord | undefined
        >();
        return Effect.void;
      },
    });

    expect(definition.process).toBeDefined();
  });

  it("omits the tracking property from untracked definitions", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      process: () => Effect.void,
    });

    expect(definition).not.toHaveProperty("tracking");
  });
});
