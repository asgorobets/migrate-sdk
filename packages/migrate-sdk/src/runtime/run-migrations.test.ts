import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  DestinationPlugin,
  DestinationPluginError,
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationItemState,
  type MigrationRunSummary,
  type RunMigrationError,
  runMigration,
  runMigrations,
  skipItem,
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

interface PipelineFailureTestError {
  readonly _tag: "PipelineFailureTestError";
  readonly code: string;
  readonly message: string;
}

interface StructuralSkipItem {
  readonly _tag: "SkipItem";
  readonly reason: string;
}

describe("runMigration", () => {
  it("keeps item-level pipeline error types out of public run errors", () => {
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
      Effect.Effect<MigrationRunSummary, RunMigrationError>
    >();
    expectTypeOf(
      runMigrations({ definitions: [definition, otherDefinition] })
    ).toEqualTypeOf<Effect.Effect<MigrationRunSummary, RunMigrationError>>();
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

  it.effect(
    "persists skipped Source Items without executing a Destination Command",
    () =>
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
                  publish: false,
                  title: "Draft article",
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  publish: true,
                  title: "Published article",
                },
              },
            ],
          }),
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            Effect.gen(function* () {
              if (!source.item.publish) {
                return yield* skipItem("Article is not published");
              }

              return {
                kind: "UpsertEntry" as const,
                contentType: "article",
                fields: {
                  title: source.item.title,
                },
              };
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 1,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-2"]);

        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "skipped",
            sourceVersion: "source-version-1",
            skipReason: "Article is not published",
            lastRunId: summary.runId,
          })
        );
      })
  );

  it.effect("recognizes structurally tagged Skip Item errors", () =>
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
              item: { title: "Draft article" },
            },
          ],
        }),
        destination: InMemoryDestinationPlugin.make({
          commandSchema: UpsertEntryCommand,
          state: destinationState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        pipeline: (): Effect.Effect<UpsertEntryCommand, StructuralSkipItem> =>
          Effect.fail({
            _tag: "SkipItem",
            reason: "Structurally tagged skip",
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 1,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(destinationState.executions).toEqual([]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "skipped",
          skipReason: "Structurally tagged skip",
        })
      );
    })
  );

  it.effect(
    "persists pipeline failures and continues processing Source Items",
    () =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const pipelineError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          message: "Article cannot be transformed",
          code: "missing-title",
        };

        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: {
                  title: null,
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  title: "Published article",
                },
              },
            ],
          }),
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: (source) =>
            source.identity === "article-1"
              ? Effect.fail(pipelineError)
              : Effect.succeed({
                  kind: "UpsertEntry" as const,
                  contentType: "article",
                  fields: {
                    title: source.item.title,
                  },
                }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-2"]);

        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article cannot be transformed",
              cause: pipelineError,
            },
          })
        );
        const failedState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        if (failedState === undefined) {
          throw new Error("Expected failed item state to be persisted");
        }
        const encodedState =
          yield* Schema.encodeEffect(MigrationItemState)(failedState);
        const decodedState =
          yield* Schema.decodeUnknownEffect(MigrationItemState)(encodedState);
        expect(decodedState).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            error: expect.objectContaining({
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article cannot be transformed",
            }),
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-2")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            lastRunId: summary.runId,
          })
        );
      })
  );

  it.effect(
    "persists destination failures and continues processing Source Items",
    () =>
      Effect.gen(function* () {
        const destinationExecutions: string[] = [];
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            items: [
              {
                identity: "article-1",
                version: "source-version-1",
                item: {
                  title: "Invalid article",
                },
              },
              {
                identity: "article-2",
                version: "source-version-1",
                item: {
                  title: "Published article",
                },
              },
            ],
          }),
          destination: {
            commandSchema: UpsertEntryCommand,
            layer: Layer.sync(DestinationPlugin, () => ({
              execute: (_command, context) => {
                if (context.sourceIdentity === "article-1") {
                  return Effect.fail(
                    new DestinationPluginError({
                      message: "Destination command failed",
                      cause: new Error("Destination write failed"),
                    })
                  );
                }

                destinationExecutions.push(context.sourceIdentity);

                return Effect.succeed({
                  destinationIdentity: toDestinationIdentity(
                    `entry-${context.sourceIdentity}`
                  ),
                });
              },
            })),
          },
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

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(destinationExecutions).toEqual(["article-2"]);

        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            error: expect.objectContaining({
              kind: "destination",
              errorTag: "DestinationPluginError",
              message: "Destination command failed",
              cause: expect.objectContaining({
                _tag: "DestinationPluginError",
                message: "Destination command failed",
              }),
            }),
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-2")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
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
