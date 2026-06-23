import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schedule, Schema } from "effect";
import {
  type ConfiguredSource,
  DuplicateSourceIdentityStatusWarning,
  InMemoryMigrationStore,
  InMemorySource,
  InvalidSourceItemStatusWarning,
  MigrationDefinition,
  type MigrationItemState,
  MigrationStatusRequestError,
  MigrationStore,
  MigrationStoreError,
  Source,
  SourceError,
  SourceIdentity,
  type SourceIdentitySnapshotKey,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { getMigrationStatuses } from "./get-migration-statuses.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "test-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const failingSource = {
  layer: Layer.sync(Source, () => {
    throw new Error("durable-only status must not initialize sources");
  }),
  sourceSchema: ArticleSource,
} as unknown as ConfiguredSource<
  typeof ArticleSource.Type,
  unknown,
  string,
  unknown
>;

const makeStatusOnlyDefinition = (
  store: ReturnType<typeof InMemoryMigrationStore.layer>,
  id = "articles"
) =>
  MigrationDefinition.make({
    id,
    source: failingSource,
    store,
    process: () => Effect.void,
  });

const makeStatusScanDefinition = <
  Source,
  Cursor,
  IdentityKey extends SourceIdentitySnapshotKey,
  SourceInput,
>(
  store: ReturnType<typeof InMemoryMigrationStore.layer>,
  source: ConfiguredSource<Source, Cursor, IdentityKey, SourceInput>,
  id = "articles"
) =>
  MigrationDefinition.make({
    id,
    source,
    store,
    process: () => Effect.void,
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
  Source.make({
    cursorSchema: Schema.Struct({
      offset: Schema.Number,
    }),
    identity: ArticleSourceIdentity,
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
              identityKey: `${id}-1`,
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
      const lock = {
        createdAt: new Date("2026-01-01T00:00:03.000Z"),
        definitionId,
        ownerRunId: runId,
        token: toMigrationDefinitionLockToken("lock-1"),
      };
      const updatedAt = new Date("2026-01-01T00:00:02.000Z");
      const itemStates: readonly MigrationItemState[] = [
        {
          definitionId,
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-1"
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt,
        },
        {
          definitionId,
          lastRunId: runId,
          skipReason: "No title",
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-2"
          ),
          sourceVersion: toSourceVersion("source-version-2"),
          status: "skipped",
          updatedAt,
        },
        {
          definitionId,
          error: {
            errorTag: "ProcessError",
            kind: "process",
            message: "Process failed",
          },
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-3"
          ),
          status: "failed",
          updatedAt,
        },
        {
          definitionId,
          lastRunId: runId,
          reason: "Stub requires update",
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-4"
          ),
          status: "needs-update",
          updatedAt,
        },
      ];

      storeState.latestRunStates.set(definitionId, lastRun);
      storeState.definitionLocks.set(definitionId, lock);
      for (const itemState of itemStates) {
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            itemState.definitionId,
            itemState.sourceIdentity.encoded
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
            lock,
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
      const articles = MigrationDefinition.make({
        ...makeStatusOnlyDefinition(store, "articles"),
        dependencies: {
          required: ["authors"],
        },
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
        getDefinitionLock: (id) =>
          Effect.sync(() => {
            calls.push(`getDefinitionLock:${id}`);
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
        deleteSourceCursor: () => fail("deleteSourceCursor"),
        getMigrationContract: () => fail("getMigrationContract"),
        upsertMigrationContract: () => fail("upsertMigrationContract"),
        getItemState: () => fail("getItemState"),
        listItemStates: () => fail("listItemStates"),
        deleteItemState: () => fail("deleteItemState"),
        upsertItemState: () => fail("upsertItemState"),
        createRunId: fail("createRunId"),
        beginRun: () => fail("beginRun"),
        queueRun: () => fail("queueRun"),
        attachRunExecution: () => fail("attachRunExecution"),
        markRunStartFailed: () => fail("markRunStartFailed"),
        completeRun: () => fail("completeRun"),
        failRun: () => fail("failRun"),
        acquireDefinitionLock: () => fail("acquireDefinitionLock"),
        assertDefinitionLocks: () => fail("assertDefinitionLocks"),
        releaseDefinitionLock: () => fail("releaseDefinitionLock"),
        breakDefinitionLock: () => fail("breakDefinitionLock"),
      });
      const definition = makeStatusOnlyDefinition(store);

      const report = yield* getMigrationStatuses({
        definitions: [definition],
      });

      expect(report.definitions[0]?.definitionId).toBe(definitionId);
      expect(calls).toEqual([
        "getLatestRunState:articles",
        "getDefinitionLock:articles",
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
        const sourceState = InMemorySource.makeState();
        const storedCursor = toEncodedSourceCursor('{"offset":1}');
        const migratedState: MigrationItemState = {
          definitionId,
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-1"
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt,
        };
        storeState.sourceCursors.set(definitionId, storedCursor);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            definitionId,
            migratedState.sourceIdentity.encoded
          ),
          migratedState
        );
        const definition = makeStatusScanDefinition(
          InMemoryMigrationStore.layer(storeState),
          InMemorySource.make({
            batchSize: 1,
            identity: ArticleSourceIdentity,
            items: [
              {
                identityKey: "article-1",
                item: { title: "First article" },
                version: "source-version-1",
              },
              {
                identityKey: "article-2",
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
              lock: null,
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
        getDefinitionLock: (id) =>
          Effect.sync(() => {
            calls.push(`getDefinitionLock:${id}`);
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
        deleteSourceCursor: () => fail("deleteSourceCursor"),
        getMigrationContract: () => fail("getMigrationContract"),
        upsertMigrationContract: () => fail("upsertMigrationContract"),
        getItemState: () => fail("getItemState"),
        deleteItemState: () => fail("deleteItemState"),
        upsertItemState: () => fail("upsertItemState"),
        createRunId: fail("createRunId"),
        beginRun: () => fail("beginRun"),
        queueRun: () => fail("queueRun"),
        attachRunExecution: () => fail("attachRunExecution"),
        markRunStartFailed: () => fail("markRunStartFailed"),
        completeRun: () => fail("completeRun"),
        failRun: () => fail("failRun"),
        acquireDefinitionLock: () => fail("acquireDefinitionLock"),
        assertDefinitionLocks: () => fail("assertDefinitionLocks"),
        releaseDefinitionLock: () => fail("releaseDefinitionLock"),
        breakDefinitionLock: () => fail("breakDefinitionLock"),
      });
      const definition = makeStatusScanDefinition(
        store,
        InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
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
        "getDefinitionLock:articles",
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
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-migrated"
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt,
        };
        const orphanedState: MigrationItemState = {
          definitionId,
          lastRunId: runId,
          skipReason: "Removed upstream",
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-orphaned"
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "skipped",
          updatedAt,
        };
        for (const itemState of [migratedState, orphanedState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        }
        const definition = makeStatusScanDefinition(
          InMemoryMigrationStore.layer(storeState),
          InMemorySource.make({
            identity: ArticleSourceIdentity,
            items: [
              {
                identityKey: "article-migrated",
                item: { title: "Migrated article" },
                version: "source-version-1",
              },
              {
                identityKey: "article-unprocessed",
                item: { title: "New article" },
                version: "source-version-1",
              },
              {
                identityKey: "article-invalid",
                item: { title: 123 } as unknown as typeof ArticleSource.Type,
                version: "source-version-1",
              },
              {
                identityKey: "article-duplicate",
                item: { title: "First duplicate" },
                version: "source-version-1",
              },
              {
                identityKey: "article-duplicate",
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
          sourceIdentity: SourceIdentity.fromKey(
            ArticleSourceIdentity,
            "article-invalid"
          ).encoded,
        });
        expect(report.definitions[0]?.warnings[0]).toHaveProperty("details");
        expect(report.definitions[0]?.warnings[1]).toEqual(
          new DuplicateSourceIdentityStatusWarning({
            count: 1,
            definitionId,
            sourceIdentityParts: [
              {
                name: "id",
                value: "article-duplicate",
              },
            ],
            sourceIdentity: SourceIdentity.fromKey(
              ArticleSourceIdentity,
              "article-duplicate"
            ).encoded,
          })
        );
        expect(report.warnings).toEqual(report.definitions[0]?.warnings);
      })
  );

  it.effect(
    "reports duplicate tuple source identities by encoded identity",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("business-addresses");
        const businessAddressIdentity = SourceIdentity.make({
          id: "business-address@v1",
          schema: SourceIdentity.tuple([
            SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
            SourceIdentity.part("addressIndex", Schema.Number),
          ]),
        });
        const BusinessAddress = Schema.Struct({
          city: Schema.String,
        });
        const definition = makeStatusScanDefinition(
          InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState()),
          InMemorySource.make({
            identity: businessAddressIdentity,
            sourceSchema: BusinessAddress,
            items: [
              {
                identityKey: ["bu-1", 0],
                item: { city: "Kyiv" },
                version: "source-version-1",
              },
              {
                identityKey: ["bu-1", 0],
                item: { city: "Lviv" },
                version: "source-version-2",
              },
            ],
          }),
          "business-addresses"
        );

        const report = yield* getMigrationStatuses({
          definitions: [definition],
          scanSource: true,
        });

        expect(report.definitions[0]).toMatchObject({
          definitionId,
          source: {
            duplicate: 1,
            invalid: 0,
            orphaned: 0,
            total: 2,
            unprocessed: 1,
          },
        });
        expect(report.warnings).toEqual([
          new DuplicateSourceIdentityStatusWarning({
            count: 1,
            definitionId,
            sourceIdentityParts: [
              {
                name: "businessUnitKey",
                value: "bu-1",
              },
              {
                name: "addressIndex",
                value: 0,
              },
            ],
            sourceIdentity: SourceIdentity.fromKey(businessAddressIdentity, [
              "bu-1",
              0,
            ]).encoded,
          }),
        ]);
      })
  );

  it.effect("fails with source errors when inventory cannot be read", () =>
    Effect.gen(function* () {
      const definition = makeStatusScanDefinition(
        InMemoryMigrationStore.layer(),
        InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
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

      expect(error).toBeInstanceOf(SourceError);
      expect(error.message).toBe("In-memory source read failed transiently");
    })
  );

  it.effect("applies source cursor retry wrappers during source scans", () =>
    Effect.gen(function* () {
      const sourceState = InMemorySource.makeState();
      const definition = MigrationDefinition.make({
        id: "articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
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
        store: InMemoryMigrationStore.layer(),
        process: () => Effect.void,
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
