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
  MigrationDefinitionLock,
  MigrationItemState,
  MigrationRunState,
  type MigrationRunSummary,
  MigrationStore,
  type RunMigrationError,
  runMigration,
  runMigrations,
  SourcePlugin,
  SourcePluginError,
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

const roundTripRunState = (runState: MigrationRunState) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(MigrationRunState)(runState);

    return yield* Schema.decodeUnknownEffect(MigrationRunState)(encoded);
  });

const roundTripDefinitionLock = (lock: MigrationDefinitionLock) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(MigrationDefinitionLock)(lock);

    return yield* Schema.decodeUnknownEffect(MigrationDefinitionLock)(encoded);
  });

describe("MigrationStore durable records", () => {
  it.effect("schema-round-trips beginRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runState = yield* store.beginRun([
        toMigrationDefinitionId("articles"),
      ]);

      const decoded = yield* roundTripRunState(runState);

      expect(decoded).toEqual(runState);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips completeRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runState = yield* store.beginRun([
        toMigrationDefinitionId("articles"),
      ]);

      const completed = yield* store.completeRun(runState.runId);
      const decoded = yield* roundTripRunState(completed);

      expect(completed.status).toBe("succeeded");
      expect(completed.finishedAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(completed);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips failRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runState = yield* store.beginRun([
        toMigrationDefinitionId("articles"),
      ]);

      const failed = yield* store.failRun(runState.runId);
      const decoded = yield* roundTripRunState(failed);

      expect(failed.status).toBe("failed");
      expect(failed.finishedAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(failed);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips acquired definition locks", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const lock = yield* store.acquireDefinitionLock(
        toMigrationDefinitionId("articles"),
        toMigrationRunId("run-1"),
        1000
      );

      const decoded = yield* roundTripDefinitionLock(lock);

      expect(lock.token).toBe("lock-1");
      expect(lock.expiresAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(lock);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );
});

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
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
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

  it.effect("advances Source Cursors after windows with item failures", () =>
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
          batchSize: 2,
          items: [
            {
              identity: "article-1",
              version: "source-version-1",
              item: { title: null },
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
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 2,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(summary.definitions[0]?.cursor).toEqual({ offset: 2 });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-2", "article-3"]);
      expect(storeState.sourceCursorCommits).toEqual([
        {
          definitionId: definition.id,
          cursor: { offset: 2 },
        },
      ]);
    })
  );

  it.effect(
    "processes failed backlog before cursor discovery in normal mode",
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
                identity: "article-failed",
                version: "source-version-2",
                item: { title: "Recovered article" },
              },
              {
                identity: "article-new",
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
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.sourceCursors.set(definition.id, { offset: 1 });
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-failed", "article-new"]);
      })
  );

  it.effect(
    "processes needs-update backlog before cursor discovery in normal mode",
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
                identity: "article-needs-update",
                version: "source-version-1",
                item: { title: "Reserved article" },
              },
              {
                identity: "article-new",
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
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.sourceCursors.set(definition.id, { offset: 1 });
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-needs-update"
          ),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-needs-update"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "needs-update",
            destinationIdentity: toDestinationIdentity(
              "entry-article-needs-update"
            ),
            reason: "Destination stub must be completed",
          }
        );

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          destinationState.executions.map(
            (execution) => execution.context.sourceIdentity
          )
        ).toEqual(["article-needs-update", "article-new"]);
        expect(destinationState.executions[0]?.context.previousState).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Destination stub must be completed",
          })
        );
      })
  );

  it.effect("processes only failed Migration Item States in failed mode", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-failed",
              version: "source-version-1",
              item: { title: "Recovered article" },
            },
            {
              identity: "article-needs-update",
              version: "source-version-1",
              item: { title: "Reserved article" },
            },
            {
              identity: "article-new",
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
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-failed"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "failed",
          error: {
            kind: "destination",
            errorTag: "DestinationPluginError",
            message: "Destination command failed",
          },
        }
      );
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-needs-update"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-needs-update"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "needs-update",
          destinationIdentity: toDestinationIdentity(
            "entry-article-needs-update"
          ),
          reason: "Destination stub must be completed",
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "failed" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-failed"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect("reprocesses skipped Migration Item States in skipped mode", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-skipped",
              version: "source-version-1",
              item: { title: "Previously skipped article" },
            },
            {
              identity: "article-new",
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
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-skipped"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-skipped"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "skipped",
          skipReason: "Draft article",
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "skipped" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-skipped"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect("processes exactly one Source Identity in item mode", () =>
    Effect.gen(function* () {
      const destinationState =
        InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-target",
              version: "source-version-1",
              item: { title: "Target article" },
            },
            {
              identity: "article-new",
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
          Effect.succeed({
            kind: "UpsertEntry" as const,
            contentType: "article",
            fields: {
              title: source.item.title,
            },
          }),
      });

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-target"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: toSourceIdentity("article-target"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
          destinationIdentity: toDestinationIdentity("entry-article-target"),
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentity: "article-target" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(
        destinationState.executions.map(
          (execution) => execution.context.sourceIdentity
        )
      ).toEqual(["article-target"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect(
    "records Source identity lookup failures for known Migration Item States",
    () =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: {
            layer: Layer.sync(SourcePlugin, () => ({
              lookupStrategy: "direct" as const,
              read: () => Effect.succeed({ items: [] }),
              readByIdentity: () => Effect.fail(sourceError),
            })),
          },
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          mode: { kind: "failed" },
        });

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 0,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(destinationState.executions).toEqual([]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-failed")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            lastRunId: summary.runId,
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePluginError",
              message: "Source identity lookup failed",
            }),
          })
        );
      })
  );

  it.effect(
    "preserves Destination Identity when a migrated item lookup fails",
    () =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: {
            layer: Layer.sync(SourcePlugin, () => ({
              lookupStrategy: "direct" as const,
              read: () => Effect.succeed({ items: [] }),
              readByIdentity: () => Effect.fail(sourceError),
            })),
          },
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-migrated"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
            destinationIdentity: toDestinationIdentity(
              "entry-article-migrated"
            ),
            destinationVersion: toDestinationVersion("destination-version-1"),
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          mode: { kind: "item", sourceIdentity: "article-migrated" },
        });

        expect(summary.status).toBe("failed");
        expect(destinationState.executions).toEqual([]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            destinationIdentity: "entry-article-migrated",
            destinationVersion: "destination-version-1",
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePluginError",
              message: "Source identity lookup failed",
            }),
          })
        );
      })
  );

  it.effect(
    "does not rediscover attempted backlog Source Identities in normal mode",
    () =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: {
            layer: Layer.sync(SourcePlugin, () => ({
              lookupStrategy: "direct" as const,
              read: () =>
                Effect.succeed({
                  items: [
                    {
                      identity: toSourceIdentity("article-failed"),
                      version: toSourceVersion("source-version-2"),
                      item: { title: "Rediscovered article" },
                    },
                    {
                      identity: toSourceIdentity("article-new"),
                      version: toSourceVersion("source-version-1"),
                      item: { title: "New article" },
                    },
                  ],
                }),
              readByIdentity: () => Effect.fail(sourceError),
            })),
          },
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: toSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "pipeline",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
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
        ).toEqual(["article-new"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-failed")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePluginError",
              message: "Source identity lookup failed",
            }),
          })
        );
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
