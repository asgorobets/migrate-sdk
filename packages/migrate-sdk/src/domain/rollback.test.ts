import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Schema } from "effect";
import {
  type ConfiguredSource,
  MigrationDefinition,
  type MigrationDefinitionId,
  type MigrationItemState,
  type MigrationItemStateFor,
  type MigrationRunId,
  type MigrationStore,
  type MigrationStoreError,
  type RollbackContext,
  type RollbackDefinitionRunSummary,
  type RollbackPipeline,
  type RollbackPipelineFor,
  RollbackPreflightError,
  RollbackRequestError,
  RollbackRunSummary,
  type SourceIdentitySnapshotKey,
  TrackingRecordContract,
  type TrackingRecordFor,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { expectTypeOf } from "vitest";
import {
  makeRollbackMigrationOptions,
  makeRollbackRequest,
  type RollbackMigrationOptions,
  type RollbackMigrationOptionsInput,
  type RollbackRequest,
  type RollbackRequestInput,
} from "./rollback.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;
const ArticleTrackingRecord = Schema.Struct({
  entryId: Schema.String,
  views: Schema.NumberFromString,
});
type ArticleTrackingRecord = typeof ArticleTrackingRecord.Type;

interface RollbackPipelineError {
  readonly _tag: "RollbackPipelineError";
}

const source = {} as ConfiguredSource<ArticleSource, unknown, string>;
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;
const articleTracking = TrackingRecordContract.make({
  id: "article-tracking",
  schema: ArticleTrackingRecord,
});
const articleRollbackPipeline: RollbackPipelineFor<
  typeof articleTracking
> = () => Effect.void;

describe("rollback public API", () => {
  it("normalizes rollback request and option inputs", () => {
    const rollbackPipeline: RollbackPipeline<RollbackPipelineError> = () =>
      Effect.void;
    const definition = MigrationDefinition.make<
      ArticleSource,
      never,
      unknown,
      string,
      RollbackPipelineError
    >({
      id: "articles",
      source,
      store,
      process: () => Effect.void,
      rollback: rollbackPipeline,
    });

    const definitions = [definition] as const;
    const request = makeRollbackRequest({
      definitions,
      definitionIds: ["articles"],
    });
    const requestWithSourceIdentities = makeRollbackRequest({
      definitions,
      sourceIdentityKeys: ["article-1"],
    });
    const options = makeRollbackMigrationOptions({
      sourceIdentityKeys: ["article-1"],
    });
    const dynamicSourceIdentities: string[] = ["article-2"];
    const dynamicOptions = makeRollbackMigrationOptions({
      sourceIdentityKeys: dynamicSourceIdentities,
    });

    expect(definition.rollback).toBe(rollbackPipeline);
    expect(requestWithSourceIdentities.definitions).toBe(definitions);
    expect(requestWithSourceIdentities.sourceIdentityKeys).toEqual([
      "article-1",
    ]);
    expect(request.definitionIds).toEqual([
      toMigrationDefinitionId("articles"),
    ]);
    expect(options.sourceIdentityKeys).toEqual(["article-1"]);
    expect(dynamicOptions.sourceIdentityKeys).toEqual(["article-2"]);
  });

  it("exposes distinct rollback runtime errors", () => {
    expect(new RollbackRequestError({ message: "Invalid request" })._tag).toBe(
      "RollbackRequestError"
    );
    expect(
      new RollbackPreflightError({ message: "Unsafe rollback" })._tag
    ).toBe("RollbackPreflightError");
  });

  it("rejects empty targeted source identities", () => {
    expect(() =>
      makeRollbackMigrationOptions({
        sourceIdentityKeys: [],
      })
    ).toThrow(RollbackRequestError);
  });

  it("keeps targeted source identity keys for definition-aware encoding", () => {
    const options = makeRollbackMigrationOptions({
      sourceIdentityKeys: ["article-1", "article-2", "article-1"],
    });

    expect(options.sourceIdentityKeys).toEqual([
      "article-1",
      "article-2",
      "article-1",
    ]);
  });

  it("types rollback item state with the definition tracking record contract", () => {
    const definition = MigrationDefinition.make({
      id: "articles",
      source,
      store,
      tracking: articleTracking,
      process: () => Effect.void,
      rollback: (itemState) => {
        expectTypeOf(itemState.trackingRecord).toEqualTypeOf<
          ArticleTrackingRecord | undefined
        >();
      },
    });

    expect(definition.rollback).toBeDefined();
  });

  it("derives reusable callback state from the tracking contract", () => {
    expectTypeOf<
      TrackingRecordFor<typeof articleTracking>
    >().toEqualTypeOf<ArticleTrackingRecord>();
    expectTypeOf<Parameters<typeof articleRollbackPipeline>[0]>().toEqualTypeOf<
      MigrationItemStateFor<typeof articleTracking>
    >();
  });

  it.effect("schema-round-trips rollback summaries", () =>
    Effect.gen(function* () {
      const summary: RollbackRunSummary = {
        kind: "rollback",
        definitions: [
          {
            definitionId: toMigrationDefinitionId("articles"),
            status: "succeeded",
            counts: {
              rolledBack: 1,
              failed: 0,
              skipped: 0,
            },
          },
        ],
        finishedAt: new Date("2026-01-01T00:00:01.000Z"),
        runId: toMigrationRunId("rollback-run-1"),
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: "succeeded",
      };

      const encoded = yield* Schema.encodeEffect(RollbackRunSummary)(summary);
      const decoded =
        yield* Schema.decodeUnknownEffect(RollbackRunSummary)(encoded);

      expect(decoded).toEqual(summary);
    })
  );

  it.effect("rejects invalid rollback summary counts", () =>
    Effect.gen(function* () {
      const summary = {
        kind: "rollback",
        definitions: [
          {
            definitionId: toMigrationDefinitionId("articles"),
            status: "succeeded",
            counts: {
              rolledBack: -1,
              failed: 0.5,
              skipped: 0,
            },
          },
        ],
        finishedAt: new Date("2026-01-01T00:00:01.000Z"),
        runId: toMigrationRunId("rollback-run-1"),
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: "succeeded",
      };

      const error = yield* Schema.decodeUnknownEffect(RollbackRunSummary)(
        summary
      ).pipe(Effect.flip);

      expect(error).toBeDefined();
    })
  );
});

expectTypeOf<Parameters<RollbackPipeline>[0]>().toEqualTypeOf<
  typeof MigrationItemState.Type
>();
const effectVoidRollbackPipeline: RollbackPipeline = () => Effect.void;
expectTypeOf(effectVoidRollbackPipeline).toEqualTypeOf<RollbackPipeline>();
// @ts-expect-error RollbackPipeline item state parameters are intentionally strict.
const _genericRollbackPipeline: RollbackPipeline<never> =
  articleRollbackPipeline;
expectTypeOf<RollbackContext>().toEqualTypeOf<{
  readonly definitionId: MigrationDefinitionId;
  readonly runId: MigrationRunId;
}>();
expectTypeOf<RollbackDefinitionRunSummary["counts"]>().toEqualTypeOf<{
  readonly rolledBack: number;
  readonly failed: number;
  readonly skipped: number;
}>();
expectTypeOf<RollbackRunSummary["kind"]>().toEqualTypeOf<"rollback">();
expectTypeOf<RollbackRequest>().toMatchTypeOf<RollbackRequestInput>();
expectTypeOf<RollbackMigrationOptions>().toMatchTypeOf<RollbackMigrationOptionsInput>();
expectTypeOf<RollbackMigrationOptions["sourceIdentityKeys"]>().toEqualTypeOf<
  | readonly [SourceIdentitySnapshotKey, ...SourceIdentitySnapshotKey[]]
  | undefined
>();
expectTypeOf<
  RollbackMigrationOptionsInput["sourceIdentityKeys"]
>().toEqualTypeOf<readonly SourceIdentitySnapshotKey[] | undefined>();
