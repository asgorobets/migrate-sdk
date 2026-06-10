import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect";
import {
  type ConfiguredDestinationPlugin,
  type ConfiguredSourcePlugin,
  type DestinationCommand,
  DestinationPlugin,
  DuplicateSourceIdentityStatusWarning,
  defineMigration,
  defineSourcePlugin,
  getMigrationStatuses,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  InvalidSourceItemStatusWarning,
  type MigrationItemState,
  MigrationStatusRequestError,
  MigrationStore,
  MigrationStoreError,
  SourcePlugin,
  SourcePluginError,
  toDestinationIdentity,
  toEncodedSourceCursor,
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

const makeStatusScanDefinition = (
  store: ReturnType<typeof InMemoryMigrationStore.layer>,
  source: ConfiguredSourcePlugin<typeof ArticleSource.Type, unknown>,
  id = "articles"
) =>
  defineMigration({
    id,
    source,
    destination: failingDestination,
    store,
    pipeline: () => ({ kind: "Noop" }),
  });

const makeObservableSource = ({
  firstTwoStarted,
  id,
  release,
  state,
}: {
  readonly firstTwoStarted: Deferred.Deferred<void>;
  readonly id: string;
  readonly release: Deferred.Deferred<void>;
  readonly state: {
    active: number;
    maxActive: number;
    readStarts: number;
    readonly events: string[];
  };
}) =>
  defineSourcePlugin({
    cursorSchema: Schema.Struct({
      offset: Schema.Number,
    }),
    sourceSchema: ArticleSource,
    lookupStrategy: "direct",
    read: () =>
      Effect.gen(function* () {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        state.readStarts += 1;
        state.events.push(`start:${id}`);

        if (state.readStarts === 2) {
          yield* Deferred.succeed(firstTwoStarted, undefined);
        }

        yield* Deferred.await(release);
        state.events.push(`finish:${id}`);
        state.active -= 1;

        return {
          items: [
            {
              identity: `${id}-1`,
              item: { title: `${id} article` },
              version: "source-version-1",
            },
          ],
        };
      }),
    readByIdentity: () => Effect.succeed(null),
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
    "scans source inventory from the beginning without updating durable progress",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-1");
        const updatedAt = new Date("2026-01-01T00:00:02.000Z");
        const storeState = InMemoryMigrationStore.makeState();
        const sourceState = InMemorySourcePlugin.makeState();
        const storedCursor = toEncodedSourceCursor('{"offset":1}');
        const migratedState: MigrationItemState = {
          definitionId,
          destinationIdentity: toDestinationIdentity("entry-1"),
          lastRunId: runId,
          sourceIdentity: toSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt,
        };
        storeState.sourceCursors.set(definitionId, storedCursor);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            definitionId,
            migratedState.sourceIdentity
          ),
          migratedState
        );
        const definition = makeStatusScanDefinition(
          InMemoryMigrationStore.layer(storeState),
          InMemorySourcePlugin.make({
            batchSize: 1,
            items: [
              {
                identity: "article-1",
                item: { title: "First article" },
                version: "source-version-1",
              },
              {
                identity: "article-2",
                item: { title: "Second article" },
                version: "source-version-1",
              },
            ],
            sourceSchema: ArticleSource,
            state: sourceState,
          })
        );

        const report = yield* getMigrationStatuses({
          definitions: [definition],
          scanSource: true,
        });

        expect(report).toEqual({
          definitions: [
            {
              definitionId,
              durable: {
                failed: 0,
                migrated: 1,
                needsUpdate: 0,
                skipped: 0,
              },
              lastRun: null,
              source: {
                duplicate: 0,
                invalid: 0,
                orphaned: 0,
                total: 2,
                unprocessed: 1,
              },
              warnings: [],
            },
          ],
          scanSource: true,
          warnings: [],
        });
        expect(sourceState.readAttempts).toBe(2);
        expect(storeState.sourceCursors.get(definitionId)).toBe(storedCursor);
        expect(storeState.sourceCursorCommits).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
        expect(Array.from(storeState.itemStates.values())).toEqual([
          migratedState,
        ]);
      })
  );

  it.effect("source scans do not touch migration progress primitives", () =>
    Effect.gen(function* () {
      const definitionId = toMigrationDefinitionId("articles");
      const calls: string[] = [];
      const fail = (method: string) =>
        Effect.fail(
          new MigrationStoreError({
            message: `source-scan status must not call ${method}`,
          })
        );
      const store = Layer.succeed(MigrationStore, {
        getLatestRunState: (id) =>
          Effect.sync(() => {
            calls.push(`getLatestRunState:${id}`);
            return null;
          }),
        listItemStates: (id) =>
          Effect.sync(() => {
            calls.push(`listItemStates:${id}`);
            return [];
          }),
        getItemStateSummary: () => fail("getItemStateSummary"),
        getSourceCursor: () => fail("getSourceCursor"),
        setSourceCursor: () => fail("setSourceCursor"),
        getItemState: () => fail("getItemState"),
        deleteItemState: () => fail("deleteItemState"),
        upsertItemState: () => fail("upsertItemState"),
        createRunId: fail("createRunId"),
        beginRun: () => fail("beginRun"),
        completeRun: () => fail("completeRun"),
        failRun: () => fail("failRun"),
        acquireDefinitionLock: () => fail("acquireDefinitionLock"),
        releaseDefinitionLock: () => fail("releaseDefinitionLock"),
      });
      const definition = makeStatusScanDefinition(
        store,
        InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-1",
              item: { title: "First article" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
        })
      );

      const report = yield* getMigrationStatuses({
        definitions: [definition],
        scanSource: true,
      });

      expect(report.definitions[0]?.definitionId).toBe(definitionId);
      expect(report.definitions[0]?.source).toEqual({
        duplicate: 0,
        invalid: 0,
        orphaned: 0,
        total: 1,
        unprocessed: 1,
      });
      expect(calls).toEqual([
        "getLatestRunState:articles",
        "listItemStates:articles",
      ]);
    })
  );

  it.effect(
    "reports invalid payloads, duplicate identities, unprocessed items, and orphaned durable state",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-1");
        const updatedAt = new Date("2026-01-01T00:00:02.000Z");
        const storeState = InMemoryMigrationStore.makeState();
        const migratedState: MigrationItemState = {
          definitionId,
          destinationIdentity: toDestinationIdentity("entry-migrated"),
          lastRunId: runId,
          sourceIdentity: toSourceIdentity("article-migrated"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt,
        };
        const orphanedState: MigrationItemState = {
          definitionId,
          lastRunId: runId,
          skipReason: "Removed upstream",
          sourceIdentity: toSourceIdentity("article-orphaned"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "skipped",
          updatedAt,
        };
        for (const itemState of [migratedState, orphanedState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity
            ),
            itemState
          );
        }
        const definition = makeStatusScanDefinition(
          InMemoryMigrationStore.layer(storeState),
          InMemorySourcePlugin.make({
            items: [
              {
                identity: "article-migrated",
                item: { title: "Migrated article" },
                version: "source-version-1",
              },
              {
                identity: "article-unprocessed",
                item: { title: "New article" },
                version: "source-version-1",
              },
              {
                identity: "article-invalid",
                item: { title: 123 } as unknown as typeof ArticleSource.Type,
                version: "source-version-1",
              },
              {
                identity: "article-duplicate",
                item: { title: "First duplicate" },
                version: "source-version-1",
              },
              {
                identity: "article-duplicate",
                item: { title: "Second duplicate" },
                version: "source-version-2",
              },
            ],
            sourceSchema: ArticleSource,
          })
        );

        const report = yield* getMigrationStatuses({
          definitions: [definition],
          scanSource: true,
        });

        expect(report.definitions[0]).toMatchObject({
          definitionId,
          durable: {
            failed: 0,
            migrated: 1,
            needsUpdate: 0,
            skipped: 1,
          },
          source: {
            duplicate: 1,
            invalid: 1,
            orphaned: 1,
            total: 5,
            unprocessed: 2,
          },
        });
        expect(report.definitions[0]?.warnings).toHaveLength(2);
        expect(report.definitions[0]?.warnings[0]).toBeInstanceOf(
          InvalidSourceItemStatusWarning
        );
        expect(report.definitions[0]?.warnings[0]).toMatchObject({
          definitionId,
          message: "Source payload did not match Source Payload Schema",
          sourceIdentity: toSourceIdentity("article-invalid"),
        });
        expect(report.definitions[0]?.warnings[0]).toHaveProperty("details");
        expect(report.definitions[0]?.warnings[1]).toEqual(
          new DuplicateSourceIdentityStatusWarning({
            count: 1,
            definitionId,
            sourceIdentity: toSourceIdentity("article-duplicate"),
          })
        );
        expect(report.warnings).toEqual(report.definitions[0]?.warnings);
      })
  );

  it.effect(
    "fails with source plugin errors when inventory cannot be read",
    () =>
      Effect.gen(function* () {
        const definition = makeStatusScanDefinition(
          InMemoryMigrationStore.layer(),
          InMemorySourcePlugin.make({
            items: [
              {
                identity: "article-1",
                item: { title: "First article" },
                version: "source-version-1",
              },
            ],
            sourceSchema: ArticleSource,
            transientFailures: { read: 1 },
          })
        );

        const error = yield* getMigrationStatuses({
          definitions: [definition],
          scanSource: true,
        }).pipe(Effect.flip);

        expect(error).toBeInstanceOf(SourcePluginError);
        expect(error.message).toBe("In-memory source read failed transiently");
      })
  );

  it.effect("applies source cursor retry wrappers during source scans", () =>
    Effect.gen(function* () {
      const sourceState = InMemorySourcePlugin.makeState();
      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          items: [
            {
              identity: "article-1",
              item: { title: "Retryable article" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
          state: sourceState,
          transientFailures: { read: 1 },
        }),
        sourceCursorRetry: (effect) =>
          effect.pipe(Effect.retry(Schedule.recurs(1))),
        destination: failingDestination,
        store: InMemoryMigrationStore.layer(),
        pipeline: () => ({ kind: "Noop" }),
      });

      const report = yield* getMigrationStatuses({
        definitions: [definition],
        scanSource: true,
      });

      expect(sourceState.readAttempts).toBe(2);
      expect(report.definitions[0]?.source).toEqual({
        duplicate: 0,
        invalid: 0,
        orphaned: 0,
        total: 1,
        unprocessed: 1,
      });
    })
  );

  it.effect(
    "bounds source scan concurrency across definitions and preserves report order",
    () =>
      Effect.gen(function* () {
        const firstTwoStarted = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const state = {
          active: 0,
          events: [] as string[],
          maxActive: 0,
          readStarts: 0,
        };
        const definitions = ["authors", "articles", "offers"].map((id) =>
          makeStatusScanDefinition(
            InMemoryMigrationStore.layer(),
            makeObservableSource({
              firstTwoStarted,
              id,
              release,
              state,
            }),
            id
          )
        );
        const fiber = yield* getMigrationStatuses({
          concurrency: 2,
          definitions,
          scanSource: true,
        }).pipe(
          Effect.forkChild({
            startImmediately: true,
          })
        );

        yield* Deferred.await(firstTwoStarted);
        expect(state.events).toEqual(["start:authors", "start:articles"]);
        expect(state.maxActive).toBe(2);

        yield* Deferred.succeed(release, undefined);
        const report = yield* Fiber.join(fiber);

        expect(state.maxActive).toBe(2);
        expect(report.definitions.map((status) => status.definitionId)).toEqual(
          [
            toMigrationDefinitionId("authors"),
            toMigrationDefinitionId("articles"),
            toMigrationDefinitionId("offers"),
          ]
        );
      })
  );
});
