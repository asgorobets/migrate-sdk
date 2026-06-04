import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  defineMigration,
  defineSourcePlugin,
  FileMigrationStore,
  InMemoryDestinationPlugin,
  InMemorySourceCursor,
  InMemorySourcePlugin,
  MigrationStore,
  runMigration,
  runMigrations,
  SourcePluginError,
  skipItem,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toSourceIdentity,
} from "../../index.ts";

const UpsertEntryCommand = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});

type UpsertEntryCommand = typeof UpsertEntryCommand.Type;

const ArticleSource = Schema.Struct({
  publish: Schema.optional(Schema.Boolean),
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;

const encodedInMemoryCursor = (offset: number) =>
  toEncodedSourceCursor(JSON.stringify({ offset }));

const testPlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

const fileStoreLayer = (directory: string) =>
  FileMigrationStore.layer({ directory, platform: testPlatformLayer });

const withTempDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      prefix: "migrate-sdk-",
    });

    return yield* use(directory);
  }).pipe(Effect.provide(testPlatformLayer));

const lockFileExists = (directory: string, definitionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    return yield* fs.exists(
      path.join(directory, "locks", `${definitionId}.json`)
    );
  });

const latestRunFileExists = (directory: string, definitionId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    return yield* fs.exists(
      path.join(directory, "definitions", definitionId, "latest-run.json")
    );
  });

const rootLatestRunFileExists = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    return yield* fs.exists(path.join(directory, "latest-run.json"));
  });

const writeCorruptItemStateRecord = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const itemStatePath = path.join(
      directory,
      "definitions",
      "articles",
      "items",
      "article:corrupt:en-US.json"
    );

    yield* fs.makeDirectory(path.dirname(itemStatePath), { recursive: true });
    yield* fs.writeFileString(itemStatePath, "{not valid json");
  });

const makeArticlesMigration = (options: {
  readonly directory: string;
  readonly destinationState: ReturnType<
    typeof InMemoryDestinationPlugin.makeState<UpsertEntryCommand>
  >;
  readonly items: readonly {
    readonly identity: string;
    readonly item: { readonly publish?: boolean; readonly title: string };
    readonly version: string;
  }[];
}) =>
  defineMigration({
    id: "articles",
    source: InMemorySourcePlugin.make<ArticleSource>({
      sourceSchema: ArticleSource,
      items: options.items,
    }),
    destination: InMemoryDestinationPlugin.make({
      commandSchema: UpsertEntryCommand,
      state: options.destinationState,
    }),
    store: fileStoreLayer(options.directory),
    pipeline: (source) =>
      Effect.gen(function* () {
        if (source.item.publish === false) {
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

describe("FileMigrationStore", () => {
  it.effect("persists Migration Item State across fresh store instances", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const firstDestinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const firstDefinition = makeArticlesMigration({
          directory,
          destinationState: firstDestinationState,
          items: [
            {
              identity: "article:1:en-US",
              version: "source-version-1",
              item: { title: "First article" },
            },
            {
              identity: "article:2:en-US",
              version: "source-version-1",
              item: { title: "Second article" },
            },
          ],
        });

        const firstSummary = yield* runMigration(firstDefinition);

        expect(firstSummary.status).toBe("succeeded");
        expect(firstSummary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });

        const secondDestinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const secondDefinition = makeArticlesMigration({
          directory,
          destinationState: secondDestinationState,
          items: [
            {
              identity: "article:1:en-US",
              version: "source-version-1",
              item: { title: "First article" },
            },
            {
              identity: "article:2:en-US",
              version: "source-version-1",
              item: { title: "Second article" },
            },
          ],
        });

        const secondSummary = yield* runMigration(secondDefinition);

        expect(secondSummary.status).toBe("succeeded");
        expect(secondSummary.definitions[0]?.counts).toEqual({
          migrated: 0,
          skipped: 0,
          failed: 0,
          unchanged: 2,
          needsUpdate: 0,
        });
        expect(secondDestinationState.executions).toEqual([]);
      })
    )
  );

  it.effect("persists encoded Source Cursor across fresh store instances", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make<ArticleSource>({
            sourceSchema: ArticleSource,
            batchSize: 1,
            items: [
              {
                identity: "article:1:en-US",
                version: "source-version-1",
                item: { title: "First article" },
              },
              {
                identity: "article:2:en-US",
                version: "source-version-1",
                item: { title: "Second article" },
              },
            ],
          }),
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: fileStoreLayer(directory),
          pipeline: (source) =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {
                title: source.item.title,
              },
            }),
        });

        yield* runMigration(definition);

        const storedCursor = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getSourceCursor(
            toMigrationDefinitionId("articles")
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(storedCursor).toEqual(encodedInMemoryCursor(1));
      })
    )
  );

  it.effect("persists latest run state per Migration Definition", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const definition = makeArticlesMigration({
          directory,
          destinationState,
          items: [
            {
              identity: "article:latest-run:en-US",
              version: "source-version-1",
              item: { title: "Latest run article" },
            },
          ],
        });

        const summary = yield* runMigration(definition);
        const hasDefinitionLatestRun = yield* latestRunFileExists(
          directory,
          "articles"
        );
        const hasRootLatestRun = yield* rootLatestRunFileExists(directory);

        expect(summary.status).toBe("succeeded");
        expect(hasDefinitionLatestRun).toBe(true);
        expect(hasRootLatestRun).toBe(false);
      })
    )
  );

  it.effect("uses persisted skipped item state in skipped mode", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const firstDestinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const firstDefinition = makeArticlesMigration({
          directory,
          destinationState: firstDestinationState,
          items: [
            {
              identity: "article:draft:en-US",
              version: "source-version-1",
              item: { publish: false, title: "Draft article" },
            },
          ],
        });

        const firstSummary = yield* runMigration(firstDefinition);

        expect(firstSummary.definitions[0]?.counts.skipped).toBe(1);
        expect(firstDestinationState.executions).toEqual([]);

        const secondDestinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const secondDefinition = makeArticlesMigration({
          directory,
          destinationState: secondDestinationState,
          items: [
            {
              identity: "article:draft:en-US",
              version: "source-version-1",
              item: { publish: true, title: "Published draft article" },
            },
          ],
        });

        const secondSummary = yield* runMigrations({
          definitions: [secondDefinition],
          mode: { kind: "skipped" },
        });

        expect(secondSummary.status).toBe("succeeded");
        expect(secondSummary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(secondDestinationState.executions).toHaveLength(1);
      })
    )
  );

  it.effect(
    "releases the Migration Definition Lock after a successful run",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const destinationState =
            InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
          const definition = makeArticlesMigration({
            directory,
            destinationState,
            items: [
              {
                identity: "article:locked:success",
                version: "source-version-1",
                item: { title: "Successful article" },
              },
            ],
          });

          const summary = yield* runMigration(definition);
          const hasLockFile = yield* lockFileExists(directory, "articles");

          expect(summary.status).toBe("succeeded");
          expect(hasLockFile).toBe(false);
        })
      )
  );

  it.effect("releases the Migration Definition Lock after a failed run", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const sourceError = new SourcePluginError({
          message: "Source read failed",
        });
        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "scan",
            read: () => Effect.fail(sourceError),
            readByIdentity: () => Effect.succeed(null),
          }),
          destination: InMemoryDestinationPlugin.make({
            commandSchema: UpsertEntryCommand,
            state: destinationState,
          }),
          store: fileStoreLayer(directory),
          pipeline: () =>
            Effect.succeed({
              kind: "UpsertEntry" as const,
              contentType: "article",
              fields: {},
            }),
        });

        const error = yield* Effect.flip(runMigration(definition));
        const hasLockFile = yield* lockFileExists(directory, "articles");

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "SourcePluginError",
            message: "Source read failed",
          })
        );
        expect(hasLockFile).toBe(false);
        expect(destinationState.executions).toEqual([]);
      })
    )
  );

  it.effect("returns MigrationStoreError for corrupt persisted records", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        yield* writeCorruptItemStateRecord(directory);

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getItemState(
            toMigrationDefinitionId("articles"),
            toSourceIdentity("article:corrupt:en-US")
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)), Effect.flip);

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: expect.stringContaining(
              "Unable to decode migration store record"
            ),
          })
        );
      })
    )
  );

  it.effect(
    "can use an application-provided FileSystem and Path platform",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const store = yield* MigrationStore;
          const runId = yield* store.createRunId;
          const runState = yield* store.beginRun(runId, [
            toMigrationDefinitionId("articles"),
          ]);

          expect(runState.status).toBe("running");
        }).pipe(
          Effect.provide(FileMigrationStore.layerWithoutPlatform({ directory }))
        )
      )
  );

  it.effect("rejects an existing Migration Definition Lock", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const lock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          const runId = yield* store.createRunId;
          const runState = yield* store.beginRun(runId, [
            toMigrationDefinitionId("articles"),
          ]);

          return yield* store.acquireDefinitionLock(
            toMigrationDefinitionId("articles"),
            runState.runId
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        const destinationState =
          InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
        const definition = makeArticlesMigration({
          directory,
          destinationState,
          items: [
            {
              identity: "article:locked:en-US",
              version: "source-version-1",
              item: { title: "Locked article" },
            },
          ],
        });

        const error = yield* Effect.flip(runMigration(definition));

        expect(lock.token).toContain("lock-");
        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(destinationState.executions).toEqual([]);
      })
    )
  );

  it.effect("rejects releasing a Definition Lock with a mismatched token", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const lock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          const runId = yield* store.createRunId;

          return yield* store.acquireDefinitionLock(definitionId, runId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        const error = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* Effect.flip(
            store.releaseDefinitionLock({
              ...lock,
              token: toMigrationDefinitionLockToken("lock-other"),
            })
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)));
        const hasLockFile = yield* lockFileExists(directory, "articles");

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition lock is owned by another runner",
          })
        );
        expect(hasLockFile).toBe(true);

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          yield* store.releaseDefinitionLock(lock);
        }).pipe(Effect.provide(fileStoreLayer(directory)));
        const hasReleasedLockFile = yield* lockFileExists(
          directory,
          "articles"
        );

        expect(hasReleasedLockFile).toBe(false);
      })
    )
  );
});
