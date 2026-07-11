import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Schema } from "effect";
import {
  type ConfiguredSource,
  type DestinationStubContext,
  type DestinationStubInput,
  type DestinationStubPipeline,
  MigrationDefinition,
  type MigrationItemStateFor,
  type MigrationStore,
  type MigrationStoreError,
  type ProcessPipelineFor,
  type SourceItem,
  type TrackingRecord,
  TrackingRecordContract,
} from "migrate-sdk";
import { expectTypeOf } from "vitest";
import type { MigrationDefinitionInputForSource } from "./definition.ts";

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
const articleProcessPipeline: ProcessPipelineFor<
  typeof source,
  never,
  typeof articleTracking
> = Effect.fn("articles.process")(function* (sourceItem, context) {
  expectTypeOf(sourceItem).toEqualTypeOf<SourceItem<ArticleSource, string>>();
  expectTypeOf(sourceItem.item).toEqualTypeOf<ArticleSource>();
  expectTypeOf(sourceItem.identity.key).toEqualTypeOf<string>();
  expectTypeOf(context.previousState).toEqualTypeOf<
    MigrationItemStateFor<typeof articleTracking> | undefined
  >();
  expectTypeOf(context.previousState?.trackingRecord).toEqualTypeOf<
    ArticleTrackingRecord | undefined
  >();
  yield* Effect.void;
});
const articleStubPipeline: DestinationStubPipeline = (input, context) => {
  expectTypeOf(input).toEqualTypeOf<DestinationStubInput>();
  expectTypeOf(context).toEqualTypeOf<DestinationStubContext>();
  return Effect.void;
};

describe("MigrationDefinition", () => {
  it("requires the tracking contract on tracked definition inputs", () => {
    const trackedDefinitionMissingTrackingInput = {
      id: "articles",
      source,
      store,
      process: () => Effect.void,
    };
    // @ts-expect-error tracked definition inputs must provide the tracking contract.
    const trackedDefinitionMissingTracking: MigrationDefinitionInputForSource<
      typeof source,
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

  it("derives reusable process callbacks from the source and tracking contract", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      tracking: articleTracking,
      process: articleProcessPipeline,
    });

    expect(definition.process).toBe(articleProcessPipeline);
  });

  it("types extracted destination stub callbacks", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      process: () => Effect.void,
      stub: articleStubPipeline,
    });

    expect(definition.stub).toBe(articleStubPipeline);
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
