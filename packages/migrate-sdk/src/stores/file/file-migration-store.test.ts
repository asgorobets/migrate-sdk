import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { systemError } from "effect/PlatformError";
import { TestClock } from "effect/testing";
import {
  InMemorySource,
  InMemorySourceCursor,
} from "migrate-sdk/sources/in-memory";
import {
  FileMigrationStore,
  FileMigrationStoreDirectoryEntries,
  FileMigrationStorePlatform,
} from "migrate-sdk/stores/file";
import { makeSourceVersionContractFingerprint } from "../../domain/migration-contract.ts";
import {
  DestinationChangeDescriptorId,
  MigrationDefinition,
  MigrationRuntimeError,
  MigrationStore,
  MigrationStoreError,
  Source,
  SourceError,
  SourceIdentity,
  type SourceItemInput,
  skipItem,
  toEncodedSourceCursor,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "../../index.ts";
import {
  runInlineDefinition,
  runInlineRegistry,
} from "../../testing/inline-registry-execution.ts";
import { runSupersededMigrationRunScenario } from "../../testing/migration-store-conformance.ts";

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

const testPlatformLayer = FileMigrationStorePlatform.node;

const sourceCursorWriteFailurePlatform = Layer.mergeAll(
  nodePathLayer,
  FileMigrationStorePlatform.directoryEntries.node,
  Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem;

      return FileSystem.of({
        ...fs,
        rename: (oldPath, newPath) =>
          newPath.endsWith("/cursor.json")
            ? Effect.fail(
                systemError({
                  _tag: "PermissionDenied",
                  description: "Injected source cursor write failure",
                  method: "rename",
                  module: "FileSystem",
                  pathOrDescriptor: newPath,
                })
              )
            : fs.rename(oldPath, newPath),
      });
    })
  ).pipe(Layer.provide(nodeFileSystemLayer))
);

const makeLatestRunWriteFailurePlatform = (
  definitionId: string,
  options: {
    readonly failRunReadAfterProjectionFailure?: boolean;
    readonly projectionFailures?: number;
  } = {}
) => {
  let armed = false;
  let projectionFailures = 0;
  let runReadFailed = false;
  const maximumProjectionFailures = options.projectionFailures ?? 1;

  return {
    arm: () => {
      armed = true;
    },
    platform: Layer.mergeAll(
      nodePathLayer,
      FileMigrationStorePlatform.directoryEntries.node,
      Layer.effect(
        FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem;

          return FileSystem.of({
            ...fs,
            readFileString: (path, encoding) => {
              if (
                armed &&
                options.failRunReadAfterProjectionFailure === true &&
                projectionFailures > 0 &&
                !runReadFailed &&
                path.includes("/runs/")
              ) {
                runReadFailed = true;
                return Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    description: "Injected Migration Run State read failure",
                    method: "readFileString",
                    module: "FileSystem",
                    pathOrDescriptor: path,
                  })
                );
              }

              return fs.readFileString(path, encoding);
            },
            rename: (oldPath, newPath) => {
              if (
                armed &&
                projectionFailures < maximumProjectionFailures &&
                newPath.endsWith(`/definitions/${definitionId}/latest-run.json`)
              ) {
                projectionFailures += 1;
                return Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    description: "Injected latest run projection failure",
                    method: "rename",
                    module: "FileSystem",
                    pathOrDescriptor: newPath,
                  })
                );
              }

              return fs.rename(oldPath, newPath);
            },
          });
        })
      ).pipe(Layer.provide(nodeFileSystemLayer))
    ),
  };
};

const makePausedTerminalProjectionPlatform = (
  definitionId: string,
  runId: string,
  paused: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>
) => {
  let didPause = false;

  return Layer.mergeAll(
    nodePathLayer,
    FileMigrationStorePlatform.directoryEntries.node,
    Layer.effect(
      FileSystem,
      Effect.gen(function* () {
        const fs = yield* FileSystem;

        return FileSystem.of({
          ...fs,
          rename: (oldPath, newPath) => {
            if (
              didPause ||
              !newPath.endsWith(`/definitions/${definitionId}/latest-run.json`)
            ) {
              return fs.rename(oldPath, newPath);
            }

            return Effect.gen(function* () {
              const pending = JSON.parse(
                yield* fs.readFileString(oldPath, "utf8")
              ) as {
                readonly state?: {
                  readonly runId?: string;
                  readonly status?: string;
                };
              };

              if (
                pending.state?.runId !== runId ||
                pending.state.status !== "succeeded"
              ) {
                return yield* fs.rename(oldPath, newPath);
              }

              didPause = true;
              yield* Deferred.succeed(paused, undefined);
              yield* Deferred.await(release);
              yield* fs.rename(oldPath, newPath);
            });
          },
        });
      })
    )
  ).pipe(Layer.provide(nodeFileSystemLayer));
};

const makeDirectoryEntriesFailurePlatform = (
  shouldFail: (directory: string) => boolean
): FileMigrationStorePlatform =>
  Layer.mergeAll(
    nodePathLayer,
    nodeFileSystemLayer,
    Layer.effect(
      FileMigrationStoreDirectoryEntries,
      Effect.gen(function* () {
        const directoryEntries = yield* FileMigrationStoreDirectoryEntries;

        return FileMigrationStoreDirectoryEntries.of({
          stream: (directory) =>
            shouldFail(directory)
              ? Stream.fail(
                  new MigrationStoreError({
                    message: "Injected directory entries failure",
                  })
                )
              : directoryEntries.stream(directory),
        });
      })
    ).pipe(Layer.provide(FileMigrationStorePlatform.directoryEntries.node))
  );

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
  readonly batchSize?: number;
  readonly directory: string;
  readonly items: readonly ArticleSourceItem[];
  readonly onProcess?: () => void;
  readonly platform?: FileMigrationStorePlatform;
  readonly processCalls?: string[];
  readonly rollbackCalls?: string[];
  readonly rollbackFailureIdentity?: string;
}) =>
  MigrationDefinition.make({
    id: "articles",
    source: InMemorySource.make({
      ...(options.batchSize === undefined
        ? {}
        : { batchSize: options.batchSize }),
      identity: TestSourceIdentity,
      sourceSchema: ArticleSource,
      items: options.items,
    }),
    store: FileMigrationStore.layer({
      directory: options.directory,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    }),
    process: (source) =>
      Effect.gen(function* () {
        options.onProcess?.();

        if (source.item.publish === false) {
          return yield* skipItem("Article is not published");
        }

        options.processCalls?.push(source.identity.encoded);
      }),
    ...(options.rollbackCalls === undefined
      ? {}
      : {
          rollback: (state) => {
            options.rollbackCalls?.push(state.sourceIdentity.encoded);

            return state.sourceIdentity.encoded ===
              options.rollbackFailureIdentity
              ? Effect.fail(
                  new MigrationRuntimeError({
                    message: "File-backed rollback failed",
                  })
                )
              : Effect.void;
          },
        }),
  });

describe("FileMigrationStore", () => {
  it.effect("uses the Effect Clock for the manifest timestamp", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const createdAt = new Date("2026-01-01T00:00:00.000Z");
        yield* TestClock.setTime(createdAt.getTime());
        yield* MigrationStore.pipe(Effect.provide(fileStoreLayer(directory)));

        const fs = yield* FileSystem;
        const path = yield* Path;
        const manifest = yield* fs.readFileString(
          path.join(directory, "manifest.json")
        );

        expect(manifest).toContain(createdAt.toISOString());
      })
    )
  );

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

        const firstSummary = yield* runInlineDefinition(firstDefinition);

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

        const secondSummary = yield* runInlineDefinition(secondDefinition);

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
    "round-trips item-state evidence across fresh store instances",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const sourceIdentity = toEncodedSourceIdentity(
            "article-rollback-failed"
          );
          const skippedSourceIdentity = toEncodedSourceIdentity(
            "article-skipped-tracked"
          );
          const failedSourceIdentity = toEncodedSourceIdentity(
            "article-failed-tracked"
          );
          const needsUpdateSourceIdentity = toEncodedSourceIdentity(
            "article-needs-update-tracked"
          );
          const sourceInventoryRunId = toMigrationRunId("run-inventory");
          const failedAt = new Date("2026-01-01T00:00:03.000Z");
          const itemState = {
            definitionId,
            journal: {
              extensions: {
                "test.import-operation@v1": {
                  operationId: "operation-1",
                  state: "processing",
                },
              },
              process: {
                entries: [
                  {
                    descriptorId: DestinationChangeDescriptorId.make(
                      "in-memory.entry.article.upserted"
                    ),
                    kind: "change" as const,
                    sequence: 0,
                    value: {
                      contentType: "article",
                      entryId: "entry:article:article-rollback-failed",
                    },
                  },
                ],
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
            lastSourceInventoryRunId: sourceInventoryRunId,
            sourceIdentity: SourceIdentity.fromEncoded(
              TestSourceIdentity,
              sourceIdentity
            ),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated" as const,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          };
          const skippedItemState = {
            definitionId,
            lastRunId: toMigrationRunId("run-skipped"),
            lastSourceInventoryRunId: sourceInventoryRunId,
            skipReason: "Update no longer needed",
            sourceIdentity: SourceIdentity.fromEncoded(
              TestSourceIdentity,
              skippedSourceIdentity
            ),
            sourceVersion: toSourceVersion("source-version-2"),
            status: "skipped" as const,
            trackingRecord: {
              entryId: "entry-skipped",
              locale: "en-US",
            },
            updatedAt: new Date("2026-01-01T00:00:01.000Z"),
          };
          const failedItemState = {
            definitionId,
            error: {
              errorTag: "PipelineFailureTestError",
              kind: "process" as const,
              message: "Update failed",
            },
            lastRunId: toMigrationRunId("run-failed"),
            lastSourceInventoryRunId: sourceInventoryRunId,
            sourceIdentity: SourceIdentity.fromEncoded(
              TestSourceIdentity,
              failedSourceIdentity
            ),
            sourceVersion: toSourceVersion("source-version-2"),
            status: "failed" as const,
            trackingRecord: {
              entryId: "entry-failed",
              locale: "en-US",
            },
            updatedAt: new Date("2026-01-01T00:00:02.000Z"),
          };
          const needsUpdateItemState = {
            definitionId,
            lastRunId: toMigrationRunId("run-needs-update"),
            lastSourceInventoryRunId: sourceInventoryRunId,
            reason: "Source version changed",
            sourceIdentity: SourceIdentity.fromEncoded(
              TestSourceIdentity,
              needsUpdateSourceIdentity
            ),
            status: "needs-update" as const,
            updatedAt: new Date("2026-01-01T00:00:03.000Z"),
          };

          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            yield* store.upsertItemState(itemState);
            yield* store.upsertItemState(skippedItemState);
            yield* store.upsertItemState(failedItemState);
            yield* store.upsertItemState(needsUpdateItemState);
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          const [stored, storedSkipped, storedFailed, storedNeedsUpdate] =
            yield* Effect.gen(function* () {
              const store = yield* MigrationStore;

              return yield* Effect.all([
                store.getItemState(definitionId, sourceIdentity),
                store.getItemState(definitionId, skippedSourceIdentity),
                store.getItemState(definitionId, failedSourceIdentity),
                store.getItemState(definitionId, needsUpdateSourceIdentity),
              ]);
            }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(stored).toEqual(itemState);
          expect(stored?.journal?.rollbackAttempts[0]?.failedAt).toBeInstanceOf(
            Date
          );
          expect(storedSkipped).toEqual(skippedItemState);
          expect(storedFailed).toEqual(failedItemState);
          expect(storedNeedsUpdate).toEqual(needsUpdateItemState);
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

  it.effect(
    "observes existing state and pages orphaned state across fresh store instances",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const inventoryRunId = toMigrationRunId("run-inventory-file");
          const makeItemState = (identity: string) => ({
            definitionId,
            lastRunId: toMigrationRunId("run-migrate-file"),
            sourceIdentity: SourceIdentity.fromKey(
              TestSourceIdentity,
              identity
            ),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated" as const,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          });

          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            yield* store.upsertItemState(makeItemState("article-c"));
            yield* store.upsertItemState(makeItemState("article-a"));
            yield* store.upsertItemState(makeItemState("article-b"));
            yield* store.observeItemState(
              definitionId,
              toEncodedSourceIdentity("article-b"),
              inventoryRunId
            );
            yield* store.observeItemState(
              definitionId,
              toEncodedSourceIdentity("article-b"),
              inventoryRunId
            );
            yield* store.observeItemState(
              definitionId,
              toEncodedSourceIdentity("article-missing"),
              inventoryRunId
            );
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          const firstPage = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            expect(
              yield* store.getItemState(
                definitionId,
                toEncodedSourceIdentity("article-b")
              )
            ).toEqual(
              expect.objectContaining({
                lastSourceInventoryRunId: inventoryRunId,
              })
            );
            expect(
              yield* store.getItemState(
                definitionId,
                toEncodedSourceIdentity("article-missing")
              )
            ).toBeNull();

            return yield* store.listOrphanItemStates(
              definitionId,
              inventoryRunId,
              { limit: 1 }
            );
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(
            firstPage.items.map((state) => state.sourceIdentity.encoded)
          ).toEqual(["article-a"]);
          expect(firstPage.nextAfterIdentity).toBe("article-a");

          yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            yield* store.deleteItemState(
              definitionId,
              toEncodedSourceIdentity("article-a")
            );
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          const secondPage = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* store.listOrphanItemStates(
              definitionId,
              inventoryRunId,
              {
                afterIdentity: toEncodedSourceIdentity("article-a"),
                limit: 1,
              }
            );
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(
            secondPage.items.map((state) => state.sourceIdentity.encoded)
          ).toEqual(["article-c"]);
          expect(secondPage.nextAfterIdentity).toBeUndefined();
        })
      )
  );

  it.effect(
    "rolls back file-backed orphaned state through the public TypeScript runner",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const rollbackCalls: string[] = [];
          const initialDefinition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article-current",
                item: { title: "Current article" },
                version: "source-version-1",
              },
              {
                identityKey: "article-orphan",
                item: { title: "Orphaned article" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });

          yield* runInlineDefinition(initialDefinition);

          const currentDefinition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article-current",
                item: { title: "Current article" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });
          const summary = yield* runInlineRegistry({
            definitions: [currentDefinition],
            rollbackOrphans: true,
          });

          expect(summary.status).toBe("succeeded");
          expect(summary.definitions[0]?.counts).toEqual({
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            orphaned: 1,
            rollbackFailed: 0,
            rolledBack: 1,
            skipped: 0,
            unchanged: 1,
          });
          expect(rollbackCalls).toEqual(["article-orphan"]);

          const remainingStates = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* store.listItemStates(
              toMigrationDefinitionId("articles")
            );
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(remainingStates).toEqual([
            expect.objectContaining({
              lastSourceInventoryRunId: summary.runId,
              sourceIdentity: expect.objectContaining({
                encoded: "article-current",
              }),
            }),
          ]);
          expect(
            yield* itemStateFileExists(directory, "articles", "article-orphan")
          ).toBe(false);
        })
      )
  );

  it.effect(
    "keeps orphaned state when the inline run is interrupted between scan and rollback",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const rollbackCalls: string[] = [];
          const initialDefinition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article-current",
                item: { title: "Current article" },
                version: "source-version-1",
              },
              {
                identityKey: "article-orphan",
                item: { title: "Orphaned article" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });

          yield* runInlineDefinition(initialDefinition);

          let orphanPageCount = 0;
          const interruptedDefinition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article-current",
                item: { title: "Current article" },
                version: "source-version-1",
              },
            ],
            platform: makeDirectoryEntriesFailurePlatform((itemDirectory) => {
              if (!itemDirectory.endsWith("/definitions/articles/items")) {
                return false;
              }

              orphanPageCount += 1;
              return orphanPageCount === 1;
            }),
            rollbackCalls,
          });
          const error = yield* runInlineRegistry({
            definitions: [interruptedDefinition],
            rollbackOrphans: true,
          }).pipe(Effect.flip);

          expect(error).toEqual(
            expect.objectContaining({
              _tag: "MigrationStoreError",
              message: "Injected directory entries failure",
            })
          );
          expect(rollbackCalls).toEqual([]);

          const [cursor, itemStates, latestRun] = yield* Effect.gen(
            function* () {
              const store = yield* MigrationStore;
              const definitionId = toMigrationDefinitionId("articles");

              return yield* Effect.all([
                store.getSourceCursor(definitionId),
                store.listItemStates(definitionId),
                store.getLatestRunState(definitionId),
              ]);
            }
          ).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(cursor).toBeNull();
          expect(latestRun?.status).toBe("failed");
          expect(itemStates).toHaveLength(2);
          expect(
            itemStates.find(
              (state) => state.sourceIdentity.encoded === "article-current"
            )?.lastSourceInventoryRunId
          ).toBe(latestRun?.runId);
          expect(
            itemStates.find(
              (state) => state.sourceIdentity.encoded === "article-orphan"
            )?.lastSourceInventoryRunId
          ).toBeUndefined();

          const restartedDefinition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article-current",
                item: { title: "Current article" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });
          const restarted = yield* runInlineRegistry({
            definitions: [restartedDefinition],
            rollbackOrphans: true,
          });

          expect(restarted.status).toBe("succeeded");
          expect(restarted.definitions[0]?.counts).toEqual(
            expect.objectContaining({
              orphaned: 1,
              rolledBack: 1,
              unchanged: 1,
            })
          );
          expect(rollbackCalls).toEqual(["article-orphan"]);
        })
      )
  );

  it.effect(
    "keeps the next orphan page when the inline run is interrupted between rollback pages",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const rollbackCalls: string[] = [];
          const sourceItems = Array.from({ length: 101 }, (_, index) => {
            const identity = `article-${String(index + 1).padStart(3, "0")}`;

            return {
              identityKey: identity,
              item: { title: identity },
              version: "source-version-1",
            };
          });
          const initialDefinition = makeArticlesMigration({
            directory,
            items: sourceItems,
            rollbackCalls,
          });

          yield* runInlineDefinition(initialDefinition);

          let orphanPageCount = 0;
          const interruptedDefinition = makeArticlesMigration({
            directory,
            items: [],
            platform: makeDirectoryEntriesFailurePlatform((itemDirectory) => {
              if (!itemDirectory.endsWith("/definitions/articles/items")) {
                return false;
              }

              orphanPageCount += 1;
              return orphanPageCount === 2;
            }),
            rollbackCalls,
          });
          const error = yield* runInlineRegistry({
            definitions: [interruptedDefinition],
            rollbackOrphans: true,
          }).pipe(Effect.flip);

          expect(error).toEqual(
            expect.objectContaining({
              _tag: "MigrationStoreError",
              message: "Injected directory entries failure",
            })
          );
          expect(rollbackCalls).toHaveLength(100);
          expect(rollbackCalls).not.toContain("article-101");

          const [remainingStates, latestRun] = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;
            const definitionId = toMigrationDefinitionId("articles");

            return yield* Effect.all([
              store.listItemStates(definitionId),
              store.getLatestRunState(definitionId),
            ]);
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(latestRun?.status).toBe("failed");
          expect(remainingStates).toEqual([
            expect.objectContaining({
              sourceIdentity: expect.objectContaining({
                encoded: "article-101",
              }),
            }),
          ]);

          const restartedDefinition = makeArticlesMigration({
            directory,
            items: [],
            rollbackCalls,
          });
          const restarted = yield* runInlineRegistry({
            definitions: [restartedDefinition],
            rollbackOrphans: true,
          });

          expect(restarted.status).toBe("succeeded");
          expect(restarted.definitions[0]?.counts).toEqual(
            expect.objectContaining({
              orphaned: 1,
              rolledBack: 1,
            })
          );
          expect(rollbackCalls).toHaveLength(101);
          expect(rollbackCalls.at(-1)).toBe("article-101");
        })
      )
  );

  it.effect(
    "persists successful deletions and failed rollback evidence across orphan pages",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const rollbackCalls: string[] = [];
          const sourceItems = Array.from({ length: 101 }, (_, index) => {
            const identity = `article-${String(index + 1).padStart(3, "0")}`;

            return {
              identityKey: identity,
              item: { title: identity },
              version: "source-version-1",
            };
          });
          const initialDefinition = makeArticlesMigration({
            directory,
            items: sourceItems,
            rollbackCalls,
            rollbackFailureIdentity: "article-050",
          });

          yield* runInlineDefinition(initialDefinition);

          const emptyDefinition = makeArticlesMigration({
            directory,
            items: [],
            rollbackCalls,
            rollbackFailureIdentity: "article-050",
          });
          const summary = yield* runInlineRegistry({
            definitions: [emptyDefinition],
            rollbackOrphans: true,
          });

          expect(summary.status).toBe("failed");
          expect(summary.definitions[0]?.counts).toEqual({
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            orphaned: 101,
            rollbackFailed: 1,
            rolledBack: 100,
            skipped: 0,
            unchanged: 0,
          });
          expect(rollbackCalls).toHaveLength(101);

          const remainingStates = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* store.listItemStates(
              toMigrationDefinitionId("articles")
            );
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(remainingStates).toEqual([
            expect.objectContaining({
              journal: expect.objectContaining({
                rollbackAttempts: [expect.any(Object)],
              }),
              sourceIdentity: expect.objectContaining({
                encoded: "article-050",
              }),
              status: "migrated",
            }),
          ]);
        })
      )
  );

  it.effect(
    "does not advance the cursor or roll back when an observation write fails",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const rollbackCalls: string[] = [];
          const initialDefinition = makeArticlesMigration({
            batchSize: 1,
            directory,
            items: [
              {
                identityKey: "article-current-1",
                item: { title: "Current article 1" },
                version: "source-version-1",
              },
              {
                identityKey: "article-current-2",
                item: { title: "Current article 2" },
                version: "source-version-1",
              },
              {
                identityKey: "article-orphan",
                item: { title: "Orphaned article" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });

          yield* runInlineDefinition(initialDefinition);

          const fs = yield* FileSystem;
          const path = yield* Path;
          const itemStateDirectory = path.join(
            directory,
            "definitions",
            "articles",
            "items"
          );
          yield* fs.chmod(itemStateDirectory, 0o500);

          const currentDefinition = makeArticlesMigration({
            batchSize: 1,
            directory,
            items: [
              {
                identityKey: "article-current-1",
                item: { title: "Current article 1" },
                version: "source-version-1",
              },
              {
                identityKey: "article-current-2",
                item: { title: "Current article 2" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });
          const error = yield* runInlineRegistry({
            definitions: [currentDefinition],
            rollbackOrphans: true,
          }).pipe(
            Effect.ensuring(
              fs.chmod(itemStateDirectory, 0o700).pipe(Effect.orDie)
            ),
            Effect.flip
          );

          expect(error).toEqual(
            expect.objectContaining({
              _tag: "MigrationStoreError",
              message: expect.stringContaining("Unable to write"),
            })
          );
          expect(rollbackCalls).toEqual([]);

          const interruptedState = yield* Effect.gen(function* () {
            const store = yield* MigrationStore;

            return yield* Effect.all([
              store.getSourceCursor(toMigrationDefinitionId("articles")),
              store.listItemStates(toMigrationDefinitionId("articles")),
            ]);
          }).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(interruptedState[0]).toBeNull();
          expect(interruptedState[1]).toHaveLength(3);
          expect(
            interruptedState[1].every(
              (state) => state.lastSourceInventoryRunId === undefined
            )
          ).toBe(true);

          const restartedSummary = yield* runInlineRegistry({
            definitions: [currentDefinition],
            rollbackOrphans: true,
          });

          expect(restartedSummary.status).toBe("succeeded");
          expect(restartedSummary.definitions[0]?.counts).toEqual(
            expect.objectContaining({
              orphaned: 1,
              rolledBack: 1,
              unchanged: 2,
            })
          );
          expect(rollbackCalls).toEqual(["article-orphan"]);
        })
      )
  );

  it.effect(
    "restarts a fresh scan when the cursor write fails after observation",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const rollbackCalls: string[] = [];
          const initialDefinition = makeArticlesMigration({
            batchSize: 1,
            directory,
            items: [
              {
                identityKey: "article-current-1",
                item: { title: "Current article 1" },
                version: "source-version-1",
              },
              {
                identityKey: "article-current-2",
                item: { title: "Current article 2" },
                version: "source-version-1",
              },
              {
                identityKey: "article-orphan",
                item: { title: "Orphaned article" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });

          yield* runInlineDefinition(initialDefinition);

          const interruptedDefinition = makeArticlesMigration({
            batchSize: 1,
            directory,
            items: [
              {
                identityKey: "article-current-1",
                item: { title: "Current article 1" },
                version: "source-version-1",
              },
              {
                identityKey: "article-current-2",
                item: { title: "Current article 2" },
                version: "source-version-1",
              },
            ],
            platform: sourceCursorWriteFailurePlatform,
            rollbackCalls,
          });
          const error = yield* runInlineRegistry({
            definitions: [interruptedDefinition],
            rollbackOrphans: true,
          }).pipe(Effect.flip);

          expect(error).toEqual(
            expect.objectContaining({
              _tag: "MigrationStoreError",
              message: expect.stringContaining("Unable to write"),
            })
          );
          expect(rollbackCalls).toEqual([]);

          const [cursor, itemStates, latestRun] = yield* Effect.gen(
            function* () {
              const store = yield* MigrationStore;
              const definitionId = toMigrationDefinitionId("articles");

              return yield* Effect.all([
                store.getSourceCursor(definitionId),
                store.listItemStates(definitionId),
                store.getLatestRunState(definitionId),
              ]);
            }
          ).pipe(Effect.provide(fileStoreLayer(directory)));

          expect(cursor).toBeNull();
          expect(latestRun?.status).toBe("failed");
          expect(
            itemStates.find(
              (state) => state.sourceIdentity.encoded === "article-current-1"
            )?.lastSourceInventoryRunId
          ).toBe(latestRun?.runId);
          expect(
            itemStates.find(
              (state) => state.sourceIdentity.encoded === "article-current-2"
            )?.lastSourceInventoryRunId
          ).toBeUndefined();

          const restartedDefinition = makeArticlesMigration({
            batchSize: 1,
            directory,
            items: [
              {
                identityKey: "article-current-1",
                item: { title: "Current article 1" },
                version: "source-version-1",
              },
              {
                identityKey: "article-current-2",
                item: { title: "Current article 2" },
                version: "source-version-1",
              },
            ],
            rollbackCalls,
          });
          const restarted = yield* runInlineRegistry({
            definitions: [restartedDefinition],
            rollbackOrphans: true,
          });

          expect(restarted.definitions[0]?.counts).toEqual(
            expect.objectContaining({
              orphaned: 1,
              rolledBack: 1,
              unchanged: 2,
            })
          );
          expect(rollbackCalls).toEqual(["article-orphan"]);
        })
      )
  );

  it.effect("persists encoded Source Cursor across fresh store instances", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definition = MigrationDefinition.make({
          id: "articles",
          source: InMemorySource.make({
            discovery: "incremental",
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

        yield* runInlineDefinition(definition);

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

        const summary = yield* runInlineDefinition(definition);
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
          const completedRun = yield* store.completeRun(
            runId,
            [definitionId],
            [{ definitionId, status: "succeeded" }]
          );

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

          expect(yield* store.getLatestRunState(definitionId)).toEqual({
            ...completedRun,
            definitionId,
            runStatus: "succeeded",
          });
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

  it.effect(
    "completes a shared run after one definition starts a newer run",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const result = yield* runSupersededMigrationRunScenario("file").pipe(
            Effect.provide(fileStoreLayer(directory))
          );

          expect(result.originalRunState).toEqual(result.completed);
          expect(result.selectedLatest).toEqual(
            expect.objectContaining({
              definitionId: result.selectedId,
              runId: result.originalRunId,
              status: "succeeded",
            })
          );
          expect(result.dependencyLatest).toEqual(
            expect.objectContaining({
              definitionId: result.dependencyId,
              runId: result.newerRunId,
              status: "running",
            })
          );
        })
      )
  );

  it.effect("persists each definition outcome from a failed shared run", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const definitionIds = [authorsId, articlesId] as const;
        const runId = toMigrationRunId("run-mixed-file");

        const states = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.beginRun(runId, definitionIds);
          const failedRun = yield* store.failRun(runId, definitionIds, [
            { definitionId: authorsId, status: "succeeded" },
            { definitionId: articlesId, status: "failed" },
          ]);

          return yield* Effect.all([
            store.getLatestRunState(authorsId),
            store.getLatestRunState(articlesId),
          ]).pipe(Effect.map((latest) => ({ failedRun, latest })));
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(states.failedRun.status).toBe("failed");
        expect(states.latest).toEqual([
          expect.objectContaining({
            definitionId: authorsId,
            runStatus: "failed",
            status: "succeeded",
          }),
          expect.objectContaining({
            definitionId: articlesId,
            runStatus: "failed",
            status: "failed",
          }),
        ]);
      })
    )
  );

  it.effect(
    "keeps a terminal run observable when its latest projection write fails",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId(
            "terminal-projection-recovery"
          );
          const runId = toMigrationRunId("run-terminal-projection-recovery");
          const injected = makeLatestRunWriteFailurePlatform(definitionId);
          const normalStore = fileStoreLayer(directory);
          const failingStore = FileMigrationStore.layer({
            directory,
            platform: injected.platform,
          });

          yield* MigrationStore.pipe(
            Effect.flatMap((store) => store.beginRun(runId, [definitionId])),
            Effect.provide(normalStore)
          );
          injected.arm();

          yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.completeRun(
                runId,
                [definitionId],
                [{ definitionId, status: "succeeded" }]
              )
            ),
            Effect.provide(failingStore),
            Effect.flip
          );

          const afterFailure = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              Effect.all({
                latest: store.getLatestRunState(definitionId),
                run: store.getRunState(runId),
              })
            ),
            Effect.provide(normalStore)
          );

          expect(afterFailure.run).toEqual(
            expect.objectContaining({ runId, status: "succeeded" })
          );
          expect(afterFailure.latest).toEqual(
            expect.objectContaining({ runId, status: "running" })
          );

          const repaired = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.completeRun(
                runId,
                [definitionId],
                [{ definitionId, status: "succeeded" }]
              )
            ),
            Effect.andThen(
              MigrationStore.pipe(
                Effect.flatMap((store) => store.getLatestRunState(definitionId))
              )
            ),
            Effect.provide(normalStore)
          );

          expect(repaired).toEqual(
            expect.objectContaining({ runId, status: "succeeded" })
          );
        })
      )
  );

  it.effect("persists queued run state and provider execution handles", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-started-file");
        const execution = {
          adapter: "test-durable",
          executionId: "test-execution-1",
        };

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          const queued = yield* store.queueRun(runId, [definitionId]);
          expect(queued).toEqual(
            expect.objectContaining({
              runId,
              status: "queued",
            })
          );
          expect(queued).not.toHaveProperty("execution");

          const attached = yield* store.attachRunExecution(
            runId,
            [definitionId],
            execution
          );
          expect(attached).toEqual(
            expect.objectContaining({
              execution,
              runId,
              status: "queued",
            })
          );

          const startFailed = yield* store.markRunStartFailed(runId, [
            definitionId,
          ]);
          expect(startFailed).toEqual(
            expect.objectContaining({
              execution,
              runId,
              status: "start-failed",
            })
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        const persisted = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getLatestRunState(definitionId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(persisted).toEqual(
          expect.objectContaining({
            execution,
            runId,
            status: "start-failed",
          })
        );
      })
    )
  );

  it.effect(
    "does not replace a newer latest projection when retrying a partial run start",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const dependencyId = toMigrationDefinitionId("projection-dependency");
          const selectedId = toMigrationDefinitionId("projection-selected");
          const originalRunId = toMigrationRunId("run-partial-start");
          const newerRunId = toMigrationRunId("run-newer-start");
          const injected = makeLatestRunWriteFailurePlatform(selectedId);
          const storeLayer = FileMigrationStore.layer({
            directory,
            platform: injected.platform,
          });

          injected.arm();
          yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.beginRun(originalRunId, [dependencyId, selectedId])
            ),
            Effect.provide(storeLayer),
            Effect.flip
          );
          yield* MigrationStore.pipe(
            Effect.flatMap((store) => store.beginRun(newerRunId, [selectedId])),
            Effect.provide(storeLayer)
          );
          yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.beginRun(originalRunId, [dependencyId, selectedId])
            ),
            Effect.provide(storeLayer)
          );

          const latest = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              Effect.all([
                store.getLatestRunState(dependencyId),
                store.getLatestRunState(selectedId),
              ])
            ),
            Effect.provide(storeLayer)
          );

          expect(latest).toEqual([
            expect.objectContaining({ runId: originalRunId }),
            expect.objectContaining({ runId: newerRunId }),
          ]);
        })
      )
  );

  it.live(
    "does not replace a newer projection when an old run finishes after its lock is broken",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("projection-race");
          const originalRunId = toMigrationRunId("run-projection-race-old");
          const newerRunId = toMigrationRunId("run-projection-race-new");
          const paused = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const storeLayer = FileMigrationStore.layer({
            directory,
            platform: makePausedTerminalProjectionPlatform(
              definitionId,
              originalRunId,
              paused,
              release
            ),
          });

          yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.beginRun(originalRunId, [definitionId])
            ),
            Effect.provide(storeLayer)
          );
          const originalCompletion = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.completeRun(
                originalRunId,
                [definitionId],
                [{ definitionId, status: "succeeded" }]
              )
            ),
            Effect.provide(storeLayer),
            Effect.forkChild
          );
          yield* Deferred.await(paused);
          const newerStart = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.beginRun(newerRunId, [definitionId])
            ),
            Effect.provide(storeLayer),
            Effect.forkChild
          );

          yield* Effect.sleep("100 millis");
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(originalCompletion);
          yield* Fiber.join(newerStart);

          const latest = yield* MigrationStore.pipe(
            Effect.flatMap((store) => store.getLatestRunState(definitionId)),
            Effect.provide(storeLayer)
          );

          expect(latest).toEqual(
            expect.objectContaining({ runId: newerRunId, status: "running" })
          );
        })
      )
  );

  it.effect("persists cancelled run state", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-cancelled-file");

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.beginRun(runId, [definitionId]);
          const cancelled = yield* store.markRunCancelled(runId, [
            definitionId,
          ]);

          expect(cancelled).toEqual(
            expect.objectContaining({ runId, status: "cancelled" })
          );
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        const persisted = yield* Effect.flatMap(MigrationStore, (store) =>
          store.getLatestRunState(definitionId)
        ).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(persisted).toEqual(
          expect.objectContaining({ runId, status: "cancelled" })
        );
      })
    )
  );

  it.effect("persists a durable cancellation request until completion", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-cancelling-file");

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.queueRun(runId, [definitionId]);
          const requested = yield* store.requestRunCancellation(runId, [
            definitionId,
          ]);

          expect(requested.status).toBe("cancelling");
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          const begun = yield* store.beginRun(runId, [definitionId]);
          const cancelled = yield* store.completeRun(
            runId,
            [definitionId],
            [{ definitionId, status: "succeeded" }]
          );
          const lateQueue = yield* store.queueRun(runId, [definitionId]);
          const lateBegin = yield* store.beginRun(runId, [definitionId]);

          expect(begun.status).toBe("cancelling");
          expect(cancelled).toEqual(
            expect.objectContaining({ runId, status: "cancelled" })
          );
          expect(lateQueue).toEqual(cancelled);
          expect(lateBegin).toEqual(cancelled);
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

        const firstSummary = yield* runInlineDefinition(firstDefinition);

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

        const secondSummary = yield* runInlineRegistry({
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

          const summary = yield* runInlineDefinition(definition);
          const hasLockFile = yield* lockFileExists(directory, "articles");

          expect(summary.status).toBe("succeeded");
          expect(hasLockFile).toBe(false);
        })
      )
  );

  it.effect(
    "repairs a terminal projection failure without failing successful execution",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const injected = makeLatestRunWriteFailurePlatform(definitionId);
          const definition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article:projection-repair",
                item: { title: "Projection repair" },
                version: "source-version-1",
              },
            ],
            onProcess: injected.arm,
            platform: injected.platform,
          });

          const summary = yield* runInlineDefinition(definition);
          const stored = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              Effect.all({
                latest: store.getLatestRunState(definitionId),
                run: store.getRunState(summary.runId),
              })
            ),
            Effect.provide(
              FileMigrationStore.layer({
                directory,
                platform: injected.platform,
              })
            )
          );

          expect(summary.status).toBe("succeeded");
          expect(stored.run).toEqual(
            expect.objectContaining({ status: "succeeded" })
          );
          expect(stored.latest).toEqual(
            expect.objectContaining({
              runId: summary.runId,
              status: "succeeded",
            })
          );
        })
      )
  );

  it.effect(
    "surfaces persistent terminal projection failure without changing authoritative success",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const injected = makeLatestRunWriteFailurePlatform(definitionId, {
            projectionFailures: Number.POSITIVE_INFINITY,
          });
          const definition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article:persistent-projection-failure",
                item: { title: "Persistent projection failure" },
                version: "source-version-1",
              },
            ],
            onProcess: injected.arm,
            platform: injected.platform,
          });

          const error = yield* runInlineDefinition(definition).pipe(
            Effect.flip
          );
          const runId = (error.cause as { readonly runId?: string } | undefined)
            ?.runId;

          expect(error).toEqual(
            expect.objectContaining({
              _tag: "MigrationStoreError",
              message: expect.stringContaining(
                "latest Migration Definition Run State projections"
              ),
            })
          );
          expect(runId).toEqual(expect.any(String));

          if (runId === undefined) {
            return;
          }

          const authoritative = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.getRunState(toMigrationRunId(runId))
            ),
            Effect.provide(fileStoreLayer(directory))
          );

          expect(authoritative).toEqual(
            expect.objectContaining({ status: "succeeded" })
          );
        })
      )
  );

  it.effect(
    "does not overwrite committed success when terminal verification cannot read it",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const injected = makeLatestRunWriteFailurePlatform(definitionId, {
            failRunReadAfterProjectionFailure: true,
          });
          const definition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article:terminal-verification-failure",
                item: { title: "Terminal verification failure" },
                version: "source-version-1",
              },
            ],
            onProcess: injected.arm,
            platform: injected.platform,
          });

          const error = yield* runInlineDefinition(definition).pipe(
            Effect.flip
          );
          const runId = (error.cause as { readonly runId?: string } | undefined)
            ?.runId;

          expect(error).toEqual(
            expect.objectContaining({
              _tag: "MigrationStoreError",
              message: expect.stringContaining(
                "Unable to confirm Migration Run terminal state"
              ),
            })
          );
          expect(runId).toEqual(expect.any(String));

          if (runId === undefined) {
            return;
          }

          const authoritative = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.getRunState(toMigrationRunId(runId))
            ),
            Effect.provide(fileStoreLayer(directory))
          );

          expect(authoritative).toEqual(
            expect.objectContaining({ status: "succeeded" })
          );
        })
      )
  );

  it.effect("releases the Migration Definition Lock after a failed run", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const sourceError = new SourceError({
          message: "Source read failed",
        });
        const definition = MigrationDefinition.make({
          id: "articles",
          source: Source.make({
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

        const error = yield* Effect.flip(runInlineDefinition(definition));
        const hasLockFile = yield* lockFileExists(directory, "articles");

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "SourceError",
            message: "Source read failed",
          })
        );
        expect(hasLockFile).toBe(false);
      })
    )
  );

  it.effect(
    "repairs a queued projection failure before starting execution",
    () =>
      withTempDirectory((directory) =>
        Effect.gen(function* () {
          const definitionId = toMigrationDefinitionId("articles");
          const injected = makeLatestRunWriteFailurePlatform(definitionId);
          const definition = makeArticlesMigration({
            directory,
            items: [
              {
                identityKey: "article:queue-projection-repair",
                item: { title: "Queue projection repair" },
                version: "source-version-1",
              },
            ],
            platform: injected.platform,
          });

          injected.arm();
          const summary = yield* runInlineDefinition(definition);
          const stored = yield* MigrationStore.pipe(
            Effect.flatMap((store) =>
              Effect.all({
                latest: store.getLatestRunState(definitionId),
                run: store.getRunState(summary.runId),
              })
            ),
            Effect.provide(
              FileMigrationStore.layer({
                directory,
                platform: injected.platform,
              })
            )
          );

          expect(summary.status).toBe("succeeded");
          expect(stored.run).toEqual(
            expect.objectContaining({ status: "succeeded" })
          );
          expect(stored.latest).toEqual(
            expect.objectContaining({
              runId: summary.runId,
              status: "succeeded",
            })
          );
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

        const error = yield* Effect.flip(runInlineDefinition(definition));

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

  it.effect("breaks a Definition Lock without the owner token", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const ownerRunId = toMigrationRunId("run-stuck");
        const lock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.acquireDefinitionLock(definitionId, ownerRunId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        const brokenLock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          const observedLock = yield* store.getDefinitionLock(definitionId);
          expect(observedLock).toEqual(lock);

          return yield* store.breakDefinitionLock(definitionId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));
        const hasLockFile = yield* lockFileExists(directory, "articles");

        expect(brokenLock).toEqual(lock);
        expect(hasLockFile).toBe(false);

        const missingLock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          const observedLock = yield* store.getDefinitionLock(definitionId);
          expect(observedLock).toBeNull();

          return yield* store.breakDefinitionLock(definitionId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(missingLock).toBeNull();

        const reacquiredLock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.acquireDefinitionLock(definitionId, ownerRunId);
        }).pipe(Effect.provide(fileStoreLayer(directory)));

        expect(reacquiredLock.definitionId).toBe(definitionId);
      })
    )
  );
});
