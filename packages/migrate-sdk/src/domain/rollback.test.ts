import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Schema } from "effect";
import {
  type ConfiguredDestinationPlugin,
  type ConfiguredSourcePlugin,
  type DestinationCommand,
  type DestinationIdentity,
  defineMigration,
  type MigrationDefinitionId,
  type MigrationRunId,
  type MigrationStore,
  type MigrationStoreError,
  makeRollbackMigrationOptions,
  makeRollbackRequest,
  type RollbackableMigrationItemState,
  type RollbackContext,
  type RollbackDefinitionRunSummary,
  type RollbackMigrationOptions,
  type RollbackMigrationOptionsInput,
  type RollbackPipeline,
  RollbackPreflightError,
  type RollbackRequest,
  RollbackRequestError,
  type RollbackRequestInput,
  RollbackRunSummary,
  type SourceIdentity,
  type SourceIdentityInput,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
} from "migrate-sdk";
import { expectTypeOf } from "vitest";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;

interface DeleteArticleCommand extends DestinationCommand {
  readonly kind: "DeleteArticle";
}

interface RollbackPipelineError {
  readonly _tag: "RollbackPipelineError";
}

const source = {} as ConfiguredSourcePlugin<ArticleSource, unknown>;
const destination = {} as ConfiguredDestinationPlugin<DeleteArticleCommand>;
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;

describe("rollback public API", () => {
  it("normalizes rollback request and option inputs", () => {
    const rollbackPipeline: RollbackPipeline<
      DeleteArticleCommand,
      RollbackPipelineError
    > = () => Effect.succeed({ kind: "DeleteArticle" });
    const definition = defineMigration<
      ArticleSource,
      DeleteArticleCommand,
      never,
      unknown,
      RollbackPipelineError
    >({
      id: "articles",
      source,
      destination,
      store,
      pipeline: () => ({ kind: "DeleteArticle" }),
      rollback: rollbackPipeline,
    });

    const definitions = [definition] as const;
    const request = makeRollbackRequest({
      definitions,
      definitionIds: ["articles"],
    });
    const requestWithSourceIdentities = makeRollbackRequest({
      definitions,
      sourceIdentities: ["article-1"],
    });
    const options = makeRollbackMigrationOptions({
      sourceIdentities: ["article-1"],
    });
    const dynamicSourceIdentities: SourceIdentityInput[] = ["article-2"];
    const dynamicOptions = makeRollbackMigrationOptions({
      sourceIdentities: dynamicSourceIdentities,
    });

    expect(definition.rollback).toBe(rollbackPipeline);
    expect(requestWithSourceIdentities.definitions).toBe(definitions);
    expect(requestWithSourceIdentities.sourceIdentities).toEqual([
      toSourceIdentity("article-1"),
    ]);
    expect(request.definitionIds).toEqual([
      toMigrationDefinitionId("articles"),
    ]);
    expect(options.sourceIdentities).toEqual([toSourceIdentity("article-1")]);
    expect(dynamicOptions.sourceIdentities).toEqual([
      toSourceIdentity("article-2"),
    ]);
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
        sourceIdentities: [],
      })
    ).toThrow(RollbackRequestError);
  });

  it("deduplicates targeted source identities in first occurrence order", () => {
    const options = makeRollbackMigrationOptions({
      sourceIdentities: ["article-1", "article-2", "article-1"],
    });

    expect(options.sourceIdentities).toEqual([
      toSourceIdentity("article-1"),
      toSourceIdentity("article-2"),
    ]);
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

expectTypeOf<
  RollbackableMigrationItemState["destinationIdentity"]
>().toEqualTypeOf<DestinationIdentity>();
expectTypeOf<
  Extract<RollbackableMigrationItemState, { status: "skipped" }>
>().toEqualTypeOf<never>();
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
expectTypeOf<RollbackMigrationOptions["sourceIdentities"]>().toEqualTypeOf<
  readonly [SourceIdentity, ...SourceIdentity[]] | undefined
>();
expectTypeOf<RollbackMigrationOptionsInput["sourceIdentities"]>().toEqualTypeOf<
  readonly SourceIdentityInput[] | undefined
>();
