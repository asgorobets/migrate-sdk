import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  type ConfiguredSource,
  MigrationDefinition,
  type MigrationDefinitionRunSummary,
  type MigrationProgressEvent,
  MigrationStore,
  type MigrationStoreError,
  TrackingRecordContract,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { expectTypeOf } from "vitest";
import { MigrationProgress } from "./migration-progress.ts";
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

const runSummary = (
  status: MigrationDefinitionRunSummary["status"]
): MigrationDefinitionRunSummary => ({
  counts: {
    failed: status === "failed" ? 1 : 0,
    migrated: status === "succeeded" ? 1 : 0,
    needsUpdate: 0,
    skipped: 0,
    unchanged: 0,
  },
  definitionId: toMigrationDefinitionId("articles"),
  status,
});

const makeSucceededRunWithRetainedLock = Effect.fn(function* () {
  const definitionId = toMigrationDefinitionId("articles");
  const runId = toMigrationRunId("terminal-replay");
  const storeState = InMemoryMigrationStore.makeState();
  const storeLayer = InMemoryMigrationStore.layer(storeState);
  const lock = yield* Effect.gen(function* () {
    const migrationStore = yield* MigrationStore;
    const acquiredLock = yield* migrationStore.acquireDefinitionLock(
      definitionId,
      runId
    );

    yield* migrationStore.queueRun(runId, [definitionId]);
    yield* migrationStore.beginRun(runId, [definitionId]);
    yield* migrationStore.completeRun(
      runId,
      [definitionId],
      [runSummary("succeeded")]
    );

    return acquiredLock;
  }).pipe(Effect.provide(storeLayer));

  return {
    definitionId,
    lease: {
      locks: [lock],
      runId,
      scopeDefinitionIds: [definitionId],
    },
    runId,
    storeLayer,
    storeState,
  };
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

  it.effect(
    "rejects cancellation after succeeded persistence while releasing retained locks",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeSucceededRunWithRetainedLock();
        const events: MigrationProgressEvent[] = [];
        const progressLayer = Layer.succeed(MigrationProgress, {
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        const error = yield* Effect.flip(
          MigrationRunExecutor.cancel({
            definitions: [runSummary("succeeded")],
            lease: fixture.lease,
            storeLayer: fixture.storeLayer,
          }).pipe(
            Effect.provide(
              Layer.merge(MigrationRunExecutor.layer, progressLayer)
            )
          )
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            cause: {
              actualStatus: "succeeded",
              expectedStatuses: ["cancelled"],
              runId: fixture.runId,
            },
            message:
              "Migration Run finalization conflicts with its authoritative durable state",
          })
        );
        expect(fixture.storeState.runStates.get(fixture.runId)?.status).toBe(
          "succeeded"
        );
        expect(fixture.storeState.definitionLocks.size).toBe(0);
        expect(events).toEqual([]);
      })
  );

  it.effect(
    "rejects failed completion after succeeded persistence while releasing retained locks",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeSucceededRunWithRetainedLock();
        const events: MigrationProgressEvent[] = [];
        const progressLayer = Layer.succeed(MigrationProgress, {
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        const error = yield* Effect.flip(
          MigrationRunExecutor.complete({
            definitions: [runSummary("failed")],
            lease: fixture.lease,
            storeLayer: fixture.storeLayer,
          }).pipe(
            Effect.provide(
              Layer.merge(MigrationRunExecutor.layer, progressLayer)
            )
          )
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            cause: {
              actualStatus: "succeeded",
              expectedStatuses: ["failed"],
              runId: fixture.runId,
            },
            message:
              "Migration Run finalization conflicts with its authoritative durable state",
          })
        );
        expect(fixture.storeState.runStates.get(fixture.runId)?.status).toBe(
          "succeeded"
        );
        expect(fixture.storeState.definitionLocks.size).toBe(0);
        expect(events).toEqual([]);
      })
  );
});
