import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  type ConfiguredDestinationPlugin,
  type ConfiguredSourcePlugin,
  type DestinationCommand,
  DestinationPlugin,
  defineMigration,
  getMigrationStatuses,
  InMemoryMigrationStore,
  type MigrationItemState,
  MigrationStatusRequestError,
  MigrationStore,
  MigrationStoreError,
  SourcePlugin,
  toDestinationIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "migrate-sdk";

interface NoopCommand extends DestinationCommand {
  readonly kind: "Noop";
}

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const failingSource = {
  layer: Layer.sync(SourcePlugin, () => {
    throw new Error("durable-only status must not initialize source plugins");
  }),
  sourceSchema: ArticleSource,
} as unknown as ConfiguredSourcePlugin<typeof ArticleSource.Type, unknown>;

const failingDestination = {
  commandDefinitions: {},
  layer: Layer.sync(DestinationPlugin, () => {
    throw new Error(
      "durable-only status must not initialize destination plugins"
    );
  }),
} as unknown as ConfiguredDestinationPlugin<NoopCommand>;

const makeStatusOnlyDefinition = (
  store: ReturnType<typeof InMemoryMigrationStore.layer>,
  id = "articles"
) =>
  defineMigration({
    id,
    source: failingSource,
    destination: failingDestination,
    store,
    pipeline: () => ({ kind: "Noop" }),
  });

describe("getMigrationStatuses", () => {
  it.effect("returns latest run lifecycle and durable item-state counts", () =>
    Effect.gen(function* () {
      const definitionId = toMigrationDefinitionId("articles");
      const runId = toMigrationRunId("run-1");
      const storeState = InMemoryMigrationStore.makeState();
      const lastRun = {
        definitionIds: [definitionId],
        finishedAt: new Date("2026-01-01T00:00:01.000Z"),
        runId,
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: "succeeded" as const,
      };
      const updatedAt = new Date("2026-01-01T00:00:02.000Z");
      const itemStates: readonly MigrationItemState[] = [
        {
          definitionId,
          destinationIdentity: toDestinationIdentity("entry-1"),
          lastRunId: runId,
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt,
        },
        {
          definitionId,
          lastRunId: runId,
          skipReason: "No title",
          sourceIdentity: toSourceIdentity("article-2"),
          sourceVersion: toSourceVersion("source-version-2"),
          status: "skipped",
          updatedAt,
        },
        {
          definitionId,
          error: {
            errorTag: "PipelineError",
            kind: "pipeline",
            message: "Pipeline failed",
          },
          lastRunId: runId,
          sourceIdentity: toSourceIdentity("article-3"),
          status: "failed",
          updatedAt,
        },
        {
          definitionId,
          destinationIdentity: toDestinationIdentity("entry-4"),
          lastRunId: runId,
          reason: "Stub requires update",
          sourceIdentity: toSourceIdentity("article-4"),
          status: "needs-update",
          updatedAt,
        },
      ];

      storeState.latestRunStates.set(definitionId, lastRun);
      for (const itemState of itemStates) {
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            itemState.definitionId,
            itemState.sourceIdentity
          ),
          itemState
        );
      }

      const definition = makeStatusOnlyDefinition(
        InMemoryMigrationStore.layer(storeState)
      );

      const report = yield* getMigrationStatuses({
        definitions: [definition],
      });

      expect(report).toEqual({
        definitions: [
          {
            definitionId,
            durable: {
              failed: 1,
              migrated: 1,
              needsUpdate: 1,
              skipped: 1,
            },
            lastRun,
            warnings: [],
          },
        ],
        scanSource: false,
        warnings: [],
      });
    })
  );

  it.effect("filters definitions without expanding dependencies", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const authors = makeStatusOnlyDefinition(store, "authors");
      const articles = defineMigration({
        ...makeStatusOnlyDefinition(store, "articles"),
        dependsOn: ["authors"],
      });

      const report = yield* getMigrationStatuses({
        definitions: [authors, articles],
        definitionIds: ["articles"],
      });

      expect(report.definitions.map((status) => status.definitionId)).toEqual([
        toMigrationDefinitionId("articles"),
      ]);
      expect(report.definitions[0]?.lastRun).toBeNull();
      expect(report.definitions[0]?.durable).toEqual({
        failed: 0,
        migrated: 0,
        needsUpdate: 0,
        skipped: 0,
      });
    })
  );

  it.effect("uses only durable status read primitives", () =>
    Effect.gen(function* () {
      const definitionId = toMigrationDefinitionId("articles");
      const calls: string[] = [];
      const fail = (method: string) =>
        Effect.fail(
          new MigrationStoreError({
            message: `durable-only status must not call ${method}`,
          })
        );
      const store = Layer.succeed(MigrationStore, {
        getLatestRunState: (id) =>
          Effect.sync(() => {
            calls.push(`getLatestRunState:${id}`);
            return null;
          }),
        getItemStateSummary: (id) =>
          Effect.sync(() => {
            calls.push(`getItemStateSummary:${id}`);
            return {
              failed: 0,
              migrated: 0,
              needsUpdate: 0,
              skipped: 0,
            };
          }),
        getSourceCursor: () => fail("getSourceCursor"),
        setSourceCursor: () => fail("setSourceCursor"),
        getItemState: () => fail("getItemState"),
        listItemStates: () => fail("listItemStates"),
        deleteItemState: () => fail("deleteItemState"),
        upsertItemState: () => fail("upsertItemState"),
        createRunId: fail("createRunId"),
        beginRun: () => fail("beginRun"),
        completeRun: () => fail("completeRun"),
        failRun: () => fail("failRun"),
        acquireDefinitionLock: () => fail("acquireDefinitionLock"),
        releaseDefinitionLock: () => fail("releaseDefinitionLock"),
      });
      const definition = makeStatusOnlyDefinition(store);

      const report = yield* getMigrationStatuses({
        definitions: [definition],
      });

      expect(report.definitions[0]?.definitionId).toBe(definitionId);
      expect(calls).toEqual([
        "getLatestRunState:articles",
        "getItemStateSummary:articles",
      ]);
    })
  );

  it.effect("rejects unknown selected definition ids", () =>
    Effect.gen(function* () {
      const definition = makeStatusOnlyDefinition(
        InMemoryMigrationStore.layer()
      );

      const error = yield* getMigrationStatuses({
        definitions: [definition],
        definitionIds: ["missing"],
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(MigrationStatusRequestError);
    })
  );

  it.effect(
    "rejects source scanning until the source inventory slice exists",
    () =>
      Effect.gen(function* () {
        const definition = makeStatusOnlyDefinition(
          InMemoryMigrationStore.layer()
        );

        const error = yield* getMigrationStatuses({
          definitions: [definition],
          scanSource: true,
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(MigrationStatusRequestError);
        expect(error.message).toBe(
          "Source inventory scanning is not available yet"
        );
      })
  );
});
