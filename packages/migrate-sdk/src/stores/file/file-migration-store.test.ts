import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  InMemorySourceCursor,
  InMemorySourcePlugin,
} from "migrate-sdk/sources/in-memory";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import { makeSourceVersionContractFingerprint } from "../../domain/migration-contract.ts";
import {
  defineMigration,
  defineSourcePlugin,
  MigrationStore,
  runMigration,
  runMigrations,
  SourceIdentity,
  type SourceItemInput,
  SourcePluginError,
  skipItem,
  toEncodedSourceCursor,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "../../index.ts";

const TestSourceIdentity = SourceIdentity.make({
  id: "test-source@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const ArticleSource = Schema.Struct({
  publish: Schema.optional(Schema.Boolean),
  title: Schema.String,
});
type ArticleSource = typeof ArticleSource.Type;
type ArticleSourceItem = SourceItemInput<ArticleSource, string>;

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

const writeMalformedSourceIdentityItemStateRecord = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const itemStatePath = path.join(
      directory,
      "definitions",
      "articles",
      "items",
      "article-malformed-source-identity.json"
    );

    yield* fs.makeDirectory(path.dirname(itemStatePath), { recursive: true });
    yield* fs.writeFileString(
      itemStatePath,
      JSON.stringify({
        formatVersion: 1,
        recordKind: "migration-item-state",
        state: {
          definitionId: "articles",
          lastRunId: "run-1",
          sourceIdentity: {
            encoded: "article-malformed-source-identity",
            fingerprint: TestSourceIdentity.fingerprint,
            id: TestSourceIdentity.id,
            key: { id: "article-malformed-source-identity" },
          },
          sourceVersion: "source-version-1",
          status: "migrated",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      })
    );
  });

const writeMalformedJournalItemStateRecord = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const itemStatePath = path.join(
      directory,
      "definitions",
      "articles",
      "items",
      "article-malformed-journal.json"
    );

    yield* fs.makeDirectory(path.dirname(itemStatePath), { recursive: true });
    yield* fs.writeFileString(
      itemStatePath,
      JSON.stringify({
        formatVersion: 1,
        recordKind: "migration-item-state",
        state: {
          definitionId: "articles",
          error: {
            errorTag: "PipelineFailureTestError",
            kind: "process",
            message: "Process failed",
          },
          journal: {
            process: {
              entries: [
                {
                  descriptorId: "in-memory.entry.article.upserted",
                  kind: "change",
                  sequence: "not-a-number",
                  value: {
                    contentType: "article",
                  },
                },
              ],
              runId: "run-1",
            },
            rollbackAttempts: [],
          },
          lastRunId: "run-1",
          sourceIdentity: {
            encoded: "article-malformed-journal",
            fingerprint: TestSourceIdentity.fingerprint,
            id: TestSourceIdentity.id,
            key: "article-malformed-journal",
          },
          sourceVersion: "source-version-1",
          status: "failed",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      })
    );
  });

const makeArticlesMigration = (options: {
  readonly directory: string;
  readonly items: readonly ArticleSourceItem[];
  readonly processCalls?: string[];
}) =>
  defineMigration({
    id: "articles",
    source: InMemorySourcePlugin.make({
      identity: TestSourceIdentity,
      sourceSchema: ArticleSource,
      items: options.items,
    }),
    store: fileStoreLayer(options.directory),
    process: (source, context) =>
      Effect.gen(function* () {
        if (source.item.publish === false) {
          return yield* skipItem("Article is not published");
        }

        options.processCalls?.push(source.identity.encoded);
        void context;
      }),
  });

describe("FileMigrationStore", () => {
  it.effect("persists Migration Contract across fresh store instances", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const sourceVersionContractFingerprint =
          makeSourceVersionContractFingerprint({
            kind: "field",
            field: "updatedAt",
          });
        const contract = {
          definitionId,
          sourceIdentityContractFingerprint: TestSourceIdentity.fingerprint,
          sourceVersionContractFingerprint,
        };

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          yield* store.upsertMigrationContract(contract);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        const stored = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getMigrationContract(definitionId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(stored).toEqual(contract);
      })
    )
  );

  it.effect("persists Migration Item State across fresh store instances", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const firstDefinition = makeArticlesMigration({
          directory,
          items: [
            {
              identityKey: "article:1:en-US",
              version: "source-version-1",
              item: { title: "First article" },
            },
            {
              identityKey: "article:2:en-US",
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

        const secondProcessCalls: string[] = [];
        const secondDefinition = makeArticlesMigration({
          directory,
          items: [
            {
              identityKey: "article:1:en-US",
              version: "source-version-1",
              item: { title: "First article" },
            },
            {
              identityKey: "article:2:en-US",
              version: "source-version-1",
              item: { title: "Second article" },
            },
          ],
          processCalls: secondProcessCalls,
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
        expect(secondProcessCalls).toEqual([]);
      })
    )
  );

  it.effect(
    "round-trips failed rollback attempt journals across fresh store instances",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const sourceIdentity = toEncodedSourceIdentity(
            "article-rollback-failed"
          );
          const failedAt = new Date("2026-01-01T00:00:03.000Z");
          const itemState = {
            definitionId,
            journal: {
              process: {
                entries: [],
                runId: toMigrationRunId("run-process"),
              },
              rollbackAttempts: [
                {
                  entries: [],
                  error: {
                    errorTag: "RollbackFailureTestError",
                    kind: "process" as const,
                    message: "Rollback failed",
                  },
                  failedAt,
                  runId: toMigrationRunId("run-rollback"),
                },
              ],
            },
            lastRunId: toMigrationRunId("run-process"),
            sourceIdentity: SourceIdentity.fromEncoded(
              TestSourceIdentity,
              sourceIdentity
            ),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated" as const,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          };

          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            yield* store.upsertItemState(itemState);
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          const stored = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* store.getItemState(definitionId, sourceIdentity);
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(stored).toEqual(itemState);
          expect(stored?.journal?.rollbackAttempts[0]?.failedAt).toBeInstanceOf(
            Date
          );
        })
      )
  );

  it.effect("deletes persisted Migration Item State", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const sourceIdentity = toEncodedSourceIdentity("article-delete-file");
        const itemState = {
          definitionId,
          lastRunId: toMigrationRunId("run-delete-file"),
          sourceIdentity: SourceIdentity.fromEncoded(
            TestSourceIdentity,
            sourceIdentity
          ),
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
        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            identity: TestSourceIdentity,
            sourceSchema: ArticleSource,
            batchSize: 1,
            items: [
              {
                identityKey: "article:1:en-US",
                version: "source-version-1",
                item: { title: "First article" },
              },
              {
                identityKey: "article:2:en-US",
                version: "source-version-1",
                item: { title: "Second article" },
              },
            ],
          }),
          store: fileStoreLayer(directory),
          process: () => Effect.void,
        });

        yield* runMigration(definition);

        const storedCursor = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getSourceCursor(
            toMigrationDefinitionId("articles")
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(storedCursor).toEqual(encodedInMemoryCursor(1));

        const deletedCursor = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          const definitionId = toMigrationDefinitionId("articles");

          yield* store.deleteSourceCursor(definitionId);

          return yield* store.getSourceCursor(definitionId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(deletedCursor).toBeNull();
      })
    )
  );

  it.effect("persists latest run state per Migration Definition", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definition = makeArticlesMigration({
          directory,
          items: [
            {
              identityKey: "article:latest-run:en-US",
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
            lastRunId: runId,
            sourceIdentity: SourceIdentity.fromKey(
              TestSourceIdentity,
              "article-status-1"
            ),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated",
            updatedAt,
          });
          yield* store.upsertItemState({
            definitionId,
            lastRunId: runId,
            skipReason: "Not published",
            sourceIdentity: SourceIdentity.fromKey(
              TestSourceIdentity,
              "article-status-2"
            ),
            sourceVersion: toSourceVersion("source-version-2"),
            status: "skipped",
            updatedAt,
          });
          yield* store.upsertItemState({
            definitionId,
            error: {
              errorTag: "ProcessError",
              kind: "process",
              message: "Process failed",
            },
            lastRunId: runId,
            sourceIdentity: SourceIdentity.fromKey(
              TestSourceIdentity,
              "article-status-3"
            ),
            status: "failed",
            updatedAt,
          });
          yield* store.upsertItemState({
            definitionId,
            lastRunId: runId,
            reason: "Stub requires update",
            sourceIdentity: SourceIdentity.fromKey(
              TestSourceIdentity,
              "article-status-4"
            ),
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
        const firstProcessCalls: string[] = [];
        const firstDefinition = makeArticlesMigration({
          directory,
          items: [
            {
              identityKey: "article:draft:en-US",
              version: "source-version-1",
              item: { publish: false, title: "Draft article" },
            },
          ],
          processCalls: firstProcessCalls,
        });

        const firstSummary = yield* runMigration(firstDefinition);

        expect(firstSummary.definitions[0]?.counts.skipped).toBe(1);
        expect(firstProcessCalls).toEqual([]);

        const secondProcessCalls: string[] = [];
        const secondDefinition = makeArticlesMigration({
          directory,
          items: [
            {
              identityKey: "article:draft:en-US",
              version: "source-version-1",
              item: { publish: true, title: "Published draft article" },
            },
          ],
          processCalls: secondProcessCalls,
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
        expect(secondProcessCalls).toEqual(["article:draft:en-US"]);
      })
    )
  );

  it.effect(
    "releases the Migration Definition Lock after a successful run",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article:locked:success",
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
        const sourceError = new SourcePluginError({
          message: "Source read failed",
        });
        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            identity: TestSourceIdentity,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "scan",
            read: () => Effect.fail(sourceError),
            readByIdentity: () => Effect.succeed(null),
          }),
          store: fileStoreLayer(directory),
          process: () => Effect.void,
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
            toEncodedSourceIdentity("article:corrupt:en-US")
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
    "returns MigrationStoreError for malformed persisted source identity records",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          yield* writeMalformedSourceIdentityItemStateRecord(directory);

          const error = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* store.getItemState(
              toMigrationDefinitionId("articles"),
              toEncodedSourceIdentity("article-malformed-source-identity")
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
    "returns MigrationStoreError for malformed persisted destination journal records",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          yield* writeMalformedJournalItemStateRecord(directory);

          const error = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* store.getItemState(
              toMigrationDefinitionId("articles"),
              toEncodedSourceIdentity("article-malformed-journal")
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

        const processCalls: string[] = [];
        const definition = makeArticlesMigration({
          directory,
          items: [
            {
              identityKey: "article:locked:en-US",
              version: "source-version-1",
              item: { title: "Locked article" },
            },
          ],
          processCalls,
        });

        const error = yield* Effect.flip(runMigration(definition));

        expect(lock.token).toContain("lock-");
        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(processCalls).toEqual([]);
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
