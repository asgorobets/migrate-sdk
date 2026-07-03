import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  type ConfiguredSource,
  MigrationDefinition,
  type MigrationStore,
  type MigrationStoreError,
  TrackingRecordContract,
} from "migrate-sdk";
import {
  type MigrationRunDefinitionCursorWindowInput,
  MigrationRunExecutor,
} from "./migration-run-executor.ts";
import { MigrationRunStepExecutor } from "./migration-run-step-executor.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;

const ArticleTrackingRecord = Schema.Struct({
  entryId: Schema.String,
  locale: Schema.String,
});

const source = {} as ConfiguredSource<ArticleSource, unknown, string>;
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;
const articleTracking = TrackingRecordContract.make({
  id: "article-tracking",
  schema: ArticleTrackingRecord,
});

describe("MigrationRunExecutor", () => {
  it("accepts tracked definitions at the cursor-window executor boundary", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      tracking: articleTracking,
      process: () => Effect.void,
    });
    const input = {} as MigrationRunDefinitionCursorWindowInput;
    const executorEffect = MigrationRunExecutor.executeCursorWindow(
      definition,
      input
    );
    const stepExecutorEffect = MigrationRunStepExecutor.executeCursorWindow(
      definition,
      input
    );

    expectTypeOf(executorEffect).toMatchTypeOf<
      Effect.Effect<unknown, unknown, unknown>
    >();
    expectTypeOf(stepExecutorEffect).toMatchTypeOf<
      Effect.Effect<unknown, unknown, unknown>
    >();
    expect(executorEffect).toBeDefined();
    expect(stepExecutorEffect).toBeDefined();
  });
});
