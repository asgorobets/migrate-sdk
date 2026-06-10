import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import type { InMemoryDestinationEntry } from "migrate-sdk/destinations/in-memory/testing";
import {
  type InMemoryDestinationExecution,
  type InMemoryDestinationInspection,
  InMemoryDestinationTesting,
} from "migrate-sdk/destinations/in-memory/testing";
import {
  InMemorySourceCursor,
  InMemorySourcePlugin,
} from "migrate-sdk/sources/in-memory";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import {
  type DestinationCommand,
  type DestinationCommandContext,
  type DestinationCommandResultInput,
  defineDestinationCommand,
  defineMigration,
  defineSourcePlugin,
  MigrationStore,
  makeDestinationCommandResult,
  runMigration,
  runMigrations,
  SourcePluginError,
  skipItem,
  toDestinationIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceIdentity,
  toSourceVersion,
} from "../../index.ts";

const UpsertEntryCommand = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});

type UpsertEntryCommand = typeof UpsertEntryCommand.Type;

const upsertEntryCommand = defineDestinationCommand("UpsertEntry", {
  identity: true,
  schema: UpsertEntryCommand,
});

const executeTestUpsertEntryCommand = (
  _command: UpsertEntryCommand,
  context: DestinationCommandContext
): DestinationCommandResultInput => ({
  destinationIdentity: `entry-${context.sourceIdentity}`,
  destinationVersion: "destination-version-1",
});

interface TestDestinationState<C extends DestinationCommand> {
  readonly bind: (inspection: InMemoryDestinationInspection<C>) => void;
  readonly entries: ReadonlyMap<string, InMemoryDestinationEntry>;
  readonly executeAttempts: number;
  readonly executions: readonly InMemoryDestinationExecution<C>[];
  readonly record: (execution: InMemoryDestinationExecution<C>) => void;
}

const makeTestDestinationState = <
  C extends DestinationCommand,
>(): TestDestinationState<C> => {
  const inspections: InMemoryDestinationInspection<C>[] = [];
  const executions: InMemoryDestinationExecution<C>[] = [];
  const boundInspections = () => {
    if (inspections.length === 0) {
      throw new Error("Destination fixture was not bound to the test state");
    }

    return inspections;
  };

  return {
    get entries() {
      const entries = new Map<string, InMemoryDestinationEntry>();

      for (const inspection of boundInspections()) {
        for (const [key, entry] of inspection.entries()) {
          entries.set(key, entry);
        }
      }

      return entries;
    },
    get executeAttempts() {
      return boundInspections().reduce(
        (attempts, inspection) => attempts + inspection.executeAttempts(),
        0
      );
    },
    get executions() {
      return executions.length === 0
        ? boundInspections().flatMap((inspection) => [
            ...inspection.executions(),
          ])
        : executions;
    },
    bind: (inspection) => {
      inspections.push(inspection);
    },
    record: (execution) => {
      executions.push(execution);
    },
  };
};

const trackDestinationExecute =
  <C extends DestinationCommand>(
    state: TestDestinationState<C> | undefined,
    execute: (
      command: C,
      context: DestinationCommandContext
    ) => DestinationCommandResultInput
  ) =>
  (command: C, context: DestinationCommandContext) => {
    const resultInput = execute(command, context);

    state?.record({
      command,
      context,
      result: makeDestinationCommandResult(resultInput),
    });

    return resultInput;
  };

const makeTestUpsertEntryDestination = (
  options: {
    readonly state?: ReturnType<
      typeof makeTestDestinationState<UpsertEntryCommand>
    >;
  } = {}
) => {
  const fixture = InMemoryDestinationTesting.fixture({
    command: upsertEntryCommand,
    execute: trackDestinationExecute(
      options.state,
      executeTestUpsertEntryCommand
    ),
  });
  options.state?.bind(fixture);

  return fixture.destination;
};

const ArticleSource = Schema.Struct({
  publish: Schema.optional(Schema.Boolean),
  title: Schema.String,
});

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

const itemStateFileExists = (
  directory: string,
  definitionId: string,
  sourceIdentity: string
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;

    return yield* fs.exists(
      path.join(
        directory,
        "definitions",
        definitionId,
        "items",
        `${sourceIdentity}.json`
      )
    );
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
    typeof makeTestDestinationState<UpsertEntryCommand>
  >;
  readonly items: readonly {
    readonly identity: string;
    readonly item: { readonly publish?: boolean; readonly title: string };
    readonly version: string;
  }[];
}) =>
  defineMigration({
    id: "articles",
    source: InMemorySourcePlugin.make({
      sourceSchema: ArticleSource,
      items: options.items,
    }),
    destination: makeTestUpsertEntryDestination({
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
          makeTestDestinationState<UpsertEntryCommand>();
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
          makeTestDestinationState<UpsertEntryCommand>();
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

  it.effect("deletes persisted Migration Item State", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const sourceIdentity = toSourceIdentity("article-delete-file");
        const itemState = {
          definitionId,
          destinationIdentity: toDestinationIdentity("entry-delete-file"),
          lastRunId: toMigrationRunId("run-delete-file"),
          sourceIdentity,
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          yield* store.upsertItemState(itemState);
          expect(
            yield* store.getItemState(definitionId, sourceIdentity)
          ).toEqual(itemState);

          yield* store.deleteItemState(definitionId, sourceIdentity);

          expect(
            yield* store.getItemState(definitionId, sourceIdentity)
          ).toBeNull();
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(
          yield* itemStateFileExists(
            directory,
            "articles",
            "article-delete-file"
          )
        ).toBe(false);
      })
    )
  );

  it.effect("persists encoded Source Cursor across fresh store instances", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
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
          destination: makeTestUpsertEntryDestination({
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
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
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

  it.effect("reads latest run state and item-state summaries", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-status-file");
        const updatedAt = new Date("2026-01-01T00:00:02.000Z");

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          expect(yield* store.getLatestRunState(definitionId)).toBeNull();
          yield* store.beginRun(runId, [definitionId]);
          const completedRun = yield* store.completeRun(runId, [definitionId]);

          yield* store.upsertItemState({
            definitionId,
            destinationIdentity: toDestinationIdentity("entry-status-1"),
            lastRunId: runId,
            sourceIdentity: toSourceIdentity("article-status-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated",
            updatedAt,
          });
          yield* store.upsertItemState({
            definitionId,
            lastRunId: runId,
            skipReason: "Not published",
            sourceIdentity: toSourceIdentity("article-status-2"),
            sourceVersion: toSourceVersion("source-version-2"),
            status: "skipped",
            updatedAt,
          });
          yield* store.upsertItemState({
            definitionId,
            error: {
              errorTag: "PipelineError",
              kind: "pipeline",
              message: "Pipeline failed",
            },
            lastRunId: runId,
            sourceIdentity: toSourceIdentity("article-status-3"),
            status: "failed",
            updatedAt,
          });
          yield* store.upsertItemState({
            definitionId,
            destinationIdentity: toDestinationIdentity("entry-status-4"),
            lastRunId: runId,
            reason: "Stub requires update",
            sourceIdentity: toSourceIdentity("article-status-4"),
            status: "needs-update",
            updatedAt,
          });

          expect(yield* store.getLatestRunState(definitionId)).toEqual(
            completedRun
          );
          expect(yield* store.getItemStateSummary(definitionId)).toEqual({
            failed: 1,
            migrated: 1,
            needsUpdate: 1,
            skipped: 1,
          });
        }).pipe(Effect.provide(fileStoreLayer(directory)));
      })
    )
  );

  it.effect("uses persisted skipped item state in skipped mode", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const firstDestinationState =
          makeTestDestinationState<UpsertEntryCommand>();
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
          makeTestDestinationState<UpsertEntryCommand>();
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
            makeTestDestinationState<UpsertEntryCommand>();
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
        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
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
          destination: makeTestUpsertEntryDestination({
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

        const destinationState = makeTestDestinationState<UpsertEntryCommand>();
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
