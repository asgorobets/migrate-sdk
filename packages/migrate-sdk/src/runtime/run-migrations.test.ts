import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  type MigrationRunSummary,
  type RunMigrationError,
  runMigration,
  runMigrations,
  toDestinationIdentity,
  toDestinationVersion,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "../index.ts";

const UpsertEntryCommand = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});

type UpsertEntryCommand = typeof UpsertEntryCommand.Type;

interface PipelineTestError {
  readonly _tag: "PipelineTestError";
}

interface OtherPipelineTestError {
  readonly _tag: "OtherPipelineTestError";
}

describe("runMigration", () => {
  it("preserves pipeline error types in the public run APIs", () => {
    const pipelineTestError: PipelineTestError = { _tag: "PipelineTestError" };
    const definition = defineMigration({
      id: "articles",
      source: InMemorySourcePlugin.make({
        items: [
          {
            identity: "article-1",
            version: "source-version-1",
            item: { title: "Hello, migration" },
          },
        ],
      }),
      destination: InMemoryDestinationPlugin.make({
        commandSchema: UpsertEntryCommand,
      }),
      store: InMemoryMigrationStore.layer(),
      pipeline: (): Effect.Effect<UpsertEntryCommand, PipelineTestError> =>
        Effect.fail(pipelineTestError),
    });
    const otherPipelineTestError: OtherPipelineTestError = {
      _tag: "OtherPipelineTestError",
    };
    const otherDefinition = defineMigration({
      id: "articles-copy",
      source: InMemorySourcePlugin.make({
        items: [
          {
            identity: "article-1",
            version: "source-version-1",
            item: { title: "Hello, migration" },
          },
        ],
      }),
      destination: InMemoryDestinationPlugin.make({
        commandSchema: UpsertEntryCommand,
      }),
      store: InMemoryMigrationStore.layer(),
      pipeline: (): Effect.Effect<UpsertEntryCommand, OtherPipelineTestError> =>
        Effect.fail(otherPipelineTestError),
    });

    expectTypeOf(runMigration(definition)).toEqualTypeOf<
      Effect.Effect<MigrationRunSummary, RunMigrationError<PipelineTestError>>
    >();
    expectTypeOf(
      runMigrations({ definitions: [definition, otherDefinition] })
    ).toEqualTypeOf<
      Effect.Effect<
        MigrationRunSummary,
        RunMigrationError<PipelineTestError | OtherPipelineTestError>
      >
    >();
  });

  it.effect("runs one Source Item through in-memory runtime", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: {
                title: "Hello, migration",
              },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
          state: destinationState,
          execute: (_command, context) => ({
            destinationIdentity: `entry-${context.sourceIdentity}`,
            destinationVersion: "destination-version-1",
          }),
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions).toHaveLength(1);
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });

      expect(destinationState.executions).toHaveLength(1);
      expect(destinationState.executions[0]?.command).toEqual({
        kind: "UpsertEntry",
        contentType: "article",
        fields: {
          title: "Hello, migration",
        },
      });
      expect(destinationState.executions[0]?.context.sourceIdentity).toBe(
        "article-1"
      );

      const itemState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("articles", "article-1")
      );

      expect(itemState).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-1",
          destinationIdentity: "entry-article-1",
          destinationVersion: "destination-version-1",
          lastRunId: summary.runId,
        })
      );
    })
  );

  it.effect("rejects non-positive in-memory Source batch sizes", () =>
    Effect.gen(function* () {
      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          batchSize: 0,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
        }),
        store: InMemoryMigrationStore.layer(),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const error = yield* Effect.flip(runMigration(definition));

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "SourcePluginError",
          message: "In-memory source batchSize must be a positive integer",
        })
      );
    })
  );

  it.effect("processes all Source Cursor Windows in one run", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          batchSize: 2,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
            {
              identity: "article-2",
              version: "source-version-1",
              item: { title: "Article 2" },
            },
            {
              identity: "article-3",
              version: "source-version-1",
              item: { title: "Article 3" },
            },
            {
              identity: "article-4",
              version: "source-version-1",
              item: { title: "Article 4" },
            },
            {
              identity: "article-5",
              version: "source-version-1",
              item: { title: "Article 5" },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 5,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual([
        "article-1",
        "article-2",
        "article-3",
        "article-4",
        "article-5",
      ]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual({
        offset: 4,
      });
      expect(storeState.sourceCursorCommits).toEqual([
        {
          definitionId: definition.id,
          cursor: { offset: 2 },
        },
        {
          definitionId: definition.id,
          cursor: { offset: 4 },
        },
      ]);
    })
  );

  it.effect("does not reprocess unchanged terminal Source Items", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: "Already migrated" },
            },
            {
              identity: "article-2",
              version: "source-version-1",
              item: { title: "Already skipped" },
            },
            {
              identity: "article-3",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity);

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            };
          }),
      });

      const previousRunId = toMigrationRunId("run-previous");
      const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-1"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "migrated",
          destinationIdentity: toDestinationIdentity("entry-article-1"),
        }
      );
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-2"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-2"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "skipped",
          skipReason: "No destination needed",
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 2,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual(["article-3"]);
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-3"]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
        })
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-2")
        )
      ).toEqual(
        expect.objectContaining({
          status: "skipped",
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
        })
      );
    })
  );

  it.effect("reprocesses Source Items when Source Version changes", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-1",
              version: "source-version-2",
              item: { title: "Updated article" },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
          state: destinationState,
          execute: (_command, context) => ({
            destinationIdentity: `entry-${context.sourceIdentity}`,
            destinationVersion: "destination-version-2",
          }),
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (source, context) =>
          Effect.sync(() => {
            pipelineCalls.push(
              `${source.identity}:${context.previousState?.sourceVersion}`
            );

            return {
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            };
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-1"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
          destinationIdentity: toDestinationIdentity("entry-article-1"),
          destinationVersion: toDestinationVersion("destination-version-1"),
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual(["article-1:source-version-1"]);
      expect(destinationState.executions).toHaveLength(1);
      expect(destinationState.executions[0]?.context.previousState).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-1",
        })
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-2",
          destinationVersion: "destination-version-2",
          lastRunId: summary.runId,
        })
      );
    })
  );
});
