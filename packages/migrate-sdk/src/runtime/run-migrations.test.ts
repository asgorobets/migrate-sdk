import { describe, expect, it } from "@effect/vitest";
import {
  Console,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Schedule,
  Schema,
} from "effect";
import { MinimumLogLevel } from "effect/References";
import { TestClock } from "effect/testing";
import type { InMemoryEntryUpsertedChange } from "migrate-sdk/destinations/in-memory";
import { expectTypeOf } from "vitest";
import {
  defaultSourceVersionContractFingerprint,
  makeSourceVersionContractFingerprint,
} from "../domain/migration-contract.ts";
import {
  DestinationChangeDescriptor,
  defineMigration,
  defineSourcePlugin,
  InMemoryDestination,
  InMemoryMigrationStore,
  type InMemoryMigrationStoreState,
  InMemorySourceCursor,
  type InMemorySourceOptions,
  InMemorySourcePlugin,
  MigrationDefinitionLock,
  MigrationItemState,
  MigrationProgress,
  type MigrationProgressEvent,
  type MigrationReference,
  MigrationReferenceLookup,
  MigrationRunState,
  type MigrationRunSummary,
  MigrationRuntimeError,
  MigrationStore,
  MigrationStoreError,
  type RollbackContext,
  type RollbackMigrationError,
  RollbackPreflightError,
  RollbackProgress,
  type RollbackProgressEvent,
  RollbackRequestError,
  type RollbackRunSummary,
  type RunMigrationError,
  rollbackMigration,
  rollbackMigrations,
  runMigration,
  runMigrations,
  SourceIdentity,
  type SourceIdentityDefinition,
  type SourceItemInput,
  SourceItemTotal,
  SourcePlugin,
  SourcePluginError,
  type SourcePluginImplementation,
  skipItem,
  Tracking,
  type TrackingRecordContractType,
  toEncodedSourceCursor,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
  toSourceVersion,
} from "../index.ts";

const ArticleSource = Schema.Struct({
  title: Schema.String,
  publish: Schema.optional(Schema.Boolean),
});
type ArticleSource = typeof ArticleSource.Type;

const ArticleSourceIdentity = SourceIdentity.make({
  id: "test-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const articleSourceIdentity = (key: string) =>
  SourceIdentity.fromKey(ArticleSourceIdentity, key);
const seedMigrationContract = (
  storeState: InMemoryMigrationStoreState,
  definitionId: string,
  sourceIdentity = ArticleSourceIdentity
) => {
  storeState.migrationContracts.set(toMigrationDefinitionId(definitionId), {
    definitionId: toMigrationDefinitionId(definitionId),
    sourceIdentityContractFingerprint: sourceIdentity.fingerprint,
    sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint,
  });
};
const seedTrackingMigrationContract = (
  storeState: InMemoryMigrationStoreState,
  definitionId: string,
  tracking: TrackingRecordContractType,
  sourceIdentity: SourceIdentityDefinition = ArticleSourceIdentity
) => {
  storeState.migrationContracts.set(toMigrationDefinitionId(definitionId), {
    definitionId: toMigrationDefinitionId(definitionId),
    sourceIdentityContractFingerprint: sourceIdentity.fingerprint,
    sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint,
    trackingRecordContractFingerprint: tracking.fingerprint,
    trackingRecordContractId: tracking.id,
  });
};
const seedArticleMigrationContract = (
  storeState: InMemoryMigrationStoreState
) => {
  seedMigrationContract(storeState, "articles");
};

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});
type ArticleEntryFields = typeof ArticleEntryFields.Type;
const ArticleTrackingRecord = Schema.Struct({
  entryId: Schema.String,
  locale: Schema.String,
});
type ArticleTrackingRecord = typeof ArticleTrackingRecord.Type;
const DecodingArticleEntryFields = Schema.Struct({
  views: Schema.NumberFromString,
});
const ArticleEntryDestinationForTypes = InMemoryDestination.makeEntries({
  contentType: "article",
  fields: ArticleEntryFields,
});
expectTypeOf(ArticleEntryDestinationForTypes.entries.upsert)
  .parameter(0)
  .toEqualTypeOf<{
    readonly title: string;
  }>();
const _validEntryFields: Parameters<
  typeof ArticleEntryDestinationForTypes.entries.upsert
>[0] = {
  title: "Typed article",
};
expect(_validEntryFields).toBeDefined();
const _invalidEntryFields: Parameters<
  typeof ArticleEntryDestinationForTypes.entries.upsert
>[0] = {
  // @ts-expect-error upsert fields must match the configured content type schema.
  headline: "Wrong field",
};
expect(_invalidEntryFields).toBeDefined();
const _invalidEntryDestination = InMemoryDestination.makeEntries({
  contentType: "article",
  // @ts-expect-error destination entry schemas validate process values without decoding.
  fields: DecodingArticleEntryFields,
});
expect(_invalidEntryDestination).toBeDefined();

const ArticleStatsSource = Schema.Struct({
  title: Schema.Trim,
  views: Schema.NumberFromString,
});
type ArticleStatsSource = typeof ArticleStatsSource.Type;

const ManyFieldSource = Schema.Struct({
  a: Schema.String,
  b: Schema.String,
  c: Schema.String,
  d: Schema.String,
  e: Schema.String,
  f: Schema.String,
});
type ManyFieldSource = typeof ManyFieldSource.Type;

const asArticleSource = (item: unknown): ArticleSource => item as ArticleSource;

const asArticleStatsSource = (item: unknown): ArticleStatsSource =>
  item as ArticleStatsSource;

const asManyFieldSource = (item: unknown): ManyFieldSource =>
  item as ManyFieldSource;

const makeTestInMemorySource = <A>(
  options: Omit<InMemorySourceOptions<A, string>, "identity" | "sourceSchema"> &
    Partial<Pick<InMemorySourceOptions<A, string>, "sourceSchema">>
) =>
  InMemorySourcePlugin.make({
    identity: ArticleSourceIdentity,
    sourceSchema: Schema.Unknown as Schema.Codec<A, unknown, never, never>,
    ...options,
  });

interface ObservableTotalDiscoverySourceState {
  readAttempts: number;
  readByIdentityAttempts: number;
  totalDiscoveryAttempts: number;
}

const makeObservableTotalDiscoverySource = ({
  batchSize,
  items,
  sourceItemTotal,
  state,
}: {
  readonly batchSize?: number;
  readonly items: readonly SourceItemInput<ArticleSource, string>[];
  readonly sourceItemTotal?: Effect.Effect<SourceItemTotal, SourcePluginError>;
  readonly state: ObservableTotalDiscoverySourceState;
}) =>
  defineSourcePlugin({
    cursorSchema: InMemorySourceCursor,
    identity: ArticleSourceIdentity,
    sourceSchema: ArticleSource,
    lookupStrategy: "direct",
    read: (cursor: InMemorySourceCursor | null) =>
      Effect.sync(() => {
        state.readAttempts += 1;
        const offset = cursor?.offset ?? 0;
        const nextOffset = offset + (batchSize ?? items.length);

        return {
          items: items.slice(offset, nextOffset),
          ...(nextOffset < items.length
            ? {
                nextCursor: {
                  offset: nextOffset,
                },
              }
            : {}),
        };
      }),
    readByIdentity: (identity) =>
      Effect.sync(() => {
        state.readByIdentityAttempts += 1;

        return (
          items.find(
            (item) =>
              SourceIdentity.fromKey(ArticleSourceIdentity, item.identityKey)
                .encoded === identity.encoded
          ) ?? null
        );
      }),
    ...(sourceItemTotal === undefined
      ? {}
      : {
          discoverSourceItemTotal: () =>
            Effect.sync(() => {
              state.totalDiscoveryAttempts += 1;
            }).pipe(Effect.andThen(sourceItemTotal)),
        }),
  });

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

const encodedInMemoryCursor = (offset: number) =>
  toEncodedSourceCursor(JSON.stringify({ offset }));

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

const releaseFailingStoreLayer = (
  state: ReturnType<typeof InMemoryMigrationStore.makeState>,
  error: MigrationStoreError,
  onRelease?: (lock: MigrationDefinitionLock) => void
) =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const store = yield* MigrationStore;

      return {
        ...store,
        releaseDefinitionLock: (lock: MigrationDefinitionLock) =>
          Effect.sync(() => {
            onRelease?.(lock);
          }).pipe(Effect.andThen(Effect.fail(error))),
      };
    })
  ).pipe(Layer.provide(InMemoryMigrationStore.layer(state)));

const failRunFailingStoreLayer = (
  state: ReturnType<typeof InMemoryMigrationStore.makeState>,
  error: MigrationStoreError
) =>
  Layer.effect(
    MigrationStore,
    Effect.gen(function* () {
      const store = yield* MigrationStore;

      return {
        ...store,
        failRun: () => Effect.fail(error),
      };
    })
  ).pipe(Layer.provide(InMemoryMigrationStore.layer(state)));

describe("MigrationStore durable records", () => {
  it.effect("schema-round-trips beginRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;
      const runState = yield* store.beginRun(runId, [
        toMigrationDefinitionId("articles"),
      ]);

      const decoded = yield* roundTripRunState(runState);

      expect(decoded).toEqual(runState);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips completeRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;
      const runState = yield* store.beginRun(runId, [
        toMigrationDefinitionId("articles"),
      ]);

      const completed = yield* store.completeRun(runState.runId, [
        toMigrationDefinitionId("articles"),
      ]);
      const decoded = yield* roundTripRunState(completed);

      expect(completed.status).toBe("succeeded");
      expect(completed.finishedAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(completed);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("schema-round-trips failRun state", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const runId = yield* store.createRunId;
      const runState = yield* store.beginRun(runId, [
        toMigrationDefinitionId("articles"),
      ]);

      const failed = yield* store.failRun(runState.runId, [
        toMigrationDefinitionId("articles"),
      ]);
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
        toMigrationRunId("run-1")
      );

      const decoded = yield* roundTripDefinitionLock(lock);

      expect(lock.token).toBe("lock-1");
      expect(lock.createdAt).toBeInstanceOf(Date);
      expect(decoded).toEqual(lock);
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );

  it.effect("rejects releasing a definition lock with a mismatched token", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const definitionId = toMigrationDefinitionId("articles");
      const lock = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.acquireDefinitionLock(
          definitionId,
          toMigrationRunId("run-1")
        );
      }).pipe(Effect.provide(InMemoryMigrationStore.layer(storeState)));

      const error = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* Effect.flip(
          store.releaseDefinitionLock({
            ...lock,
            ownerRunId: toMigrationRunId("run-2"),
            token: toMigrationDefinitionLockToken("lock-other"),
          })
        );
      }).pipe(Effect.provide(InMemoryMigrationStore.layer(storeState)));

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Migration definition lock is owned by another runner",
        })
      );
      expect(storeState.definitionLocks.get(definitionId)).toEqual(lock);
    })
  );

  it.effect("deletes Migration Item State by Source Identity", () =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const definitionId = toMigrationDefinitionId("articles");
      const sourceIdentity = toEncodedSourceIdentity("article-delete");
      const itemState = {
        definitionId,
        lastRunId: toMigrationRunId("run-1"),
        sourceIdentity: SourceIdentity.fromEncoded(
          ArticleSourceIdentity,
          sourceIdentity
        ),
        sourceVersion: toSourceVersion("source-version-1"),
        status: "migrated" as const,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      yield* store.upsertItemState(itemState);
      yield* store.deleteItemState(definitionId, sourceIdentity);

      const stored = yield* store.getItemState(definitionId, sourceIdentity);
      expect(stored).toBeNull();
    }).pipe(Effect.provide(InMemoryMigrationStore.layer()))
  );
});

describe("runMigration", () => {
  it("keeps item-level process error types out of public run errors", () => {
    const pipelineTestError: PipelineTestError = { _tag: "PipelineTestError" };
    const store = InMemoryMigrationStore.layer();
    const definition = defineMigration({
      id: "articles",
      source: makeTestInMemorySource({
        items: [
          {
            identityKey: "article-1",
            version: "source-version-1",
            item: { title: "Hello, migration" },
          },
        ],
      }),
      store,
      process: (): Effect.Effect<void, PipelineTestError> =>
        Effect.fail(pipelineTestError),
    });
    const otherPipelineTestError: OtherPipelineTestError = {
      _tag: "OtherPipelineTestError",
    };
    const otherDefinition = defineMigration({
      id: "articles-copy",
      source: makeTestInMemorySource({
        items: [
          {
            identityKey: "article-1",
            version: "source-version-1",
            item: { title: "Hello, migration" },
          },
        ],
      }),
      store,
      process: (): Effect.Effect<void, OtherPipelineTestError> =>
        Effect.fail(otherPipelineTestError),
    });

    expectTypeOf(runMigration(definition)).toEqualTypeOf<
      Effect.Effect<MigrationRunSummary, RunMigrationError>
    >();
    expectTypeOf(
      runMigrations({ definitions: [definition, otherDefinition] })
    ).toEqualTypeOf<Effect.Effect<MigrationRunSummary, RunMigrationError>>();
  });

  it.effect("returns typed runtime errors for invalid Run Request input", () =>
    Effect.gen(function* () {
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Invalid request article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(),
        process: () => Effect.void,
      });

      const error = yield* Effect.flip(
        runMigrations({ definitions: [definition], definitionIds: [""] })
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationRuntimeError",
          message: "Run request contains invalid input",
        })
      );
    })
  );

  it.effect(
    "keeps configured Source Cursor schema bound to the source layer",
    () =>
      Effect.gen(function* () {
        const cursorSchema = Schema.Number;
        const implementationWithConflictingSchema = {
          cursorSchema: Schema.String,
          lookupStrategy: "scan" as const,
          read: () =>
            Effect.succeed({
              items: [],
            }),
          readByIdentity: () => Effect.succeed(null),
        };
        const source = defineSourcePlugin({
          cursorSchema,
          identity: ArticleSourceIdentity,
          sourceSchema: Schema.Struct({ title: Schema.String }),
          make: () =>
            implementationWithConflictingSchema as unknown as SourcePluginImplementation<
              { readonly title: string },
              number,
              string
            >,
        });

        const plugin = yield* SourcePlugin.pipe(Effect.provide(source.layer));

        expect(plugin.cursorSchema).toBe(cursorSchema);
        expect(plugin.sourceSchema).toBe(source.sourceSchema);
      })
  );

  it.effect("runs one Source Item through in-memory runtime", () =>
    Effect.gen(function* () {
      const destination = InMemoryDestination.makeEntries({
        contentType: "article",
        fields: ArticleEntryFields,
      });
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Hello, migration",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          destination.entries
            .upsert({
              title: source.item.title,
            })
            .pipe(Effect.asVoid),
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

      const itemState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("articles", "article-1")
      );

      expect(itemState).toEqual(
        expect.objectContaining({
          status: "migrated",
          sourceVersion: "source-version-1",
          lastRunId: summary.runId,
          journal: {
            process: {
              entries: [
                expect.objectContaining({
                  descriptorId: destination.changes.entryUpserted.id,
                  kind: "change",
                  value: expect.objectContaining({
                    contentType: "article",
                    fields: {
                      title: "Hello, migration",
                    },
                    sourceIdentity: "article-1",
                  }),
                }),
              ],
              runId: summary.runId,
            },
            rollbackAttempts: [],
          },
        })
      );
      expect(itemState).not.toHaveProperty(`destination${"Identity"}`);
      expect(itemState).not.toHaveProperty(`destination${"Version"}`);
    })
  );

  it.effect(
    "runs a progress-only Process Pipeline without destination tracking",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: ArticleSource[] = [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Hello, process",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(source.item);
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(processCalls).toEqual([{ title: "Hello, process" }]);

        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(itemState).toEqual(
          expect.objectContaining({
            status: "migrated",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
          })
        );
        expect(itemState).not.toHaveProperty(`destination${"Identity"}`);
        expect(itemState).not.toHaveProperty(`destination${"Version"}`);
      })
  );

  it.effect(
    "bounds concurrent Process Pipeline execution for Source Items",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const state = {
          active: 0,
          maxActive: 0,
        };
        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Concurrent article 1" },
              },
              {
                identityKey: "article-2",
                version: "source-version-1",
                item: { title: "Concurrent article 2" },
              },
              {
                identityKey: "article-3",
                version: "source-version-1",
                item: { title: "Concurrent article 3" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(),
          process: () =>
            Effect.gen(function* () {
              state.active += 1;
              state.maxActive = Math.max(state.maxActive, state.active);
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Effect.sleep("1 second");
              state.active -= 1;
            }),
        });

        const fiber = yield* runMigration(definition, {
          execution: { process: { concurrency: 2 } },
        }).pipe(Effect.forkChild);

        yield* Deferred.await(firstStarted);
        yield* TestClock.adjust("500 millis");

        expect(state.maxActive).toBe(2);

        yield* TestClock.adjust("3 seconds");
        const summary = yield* Fiber.join(fiber);

        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 3,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
      })
  );

  it.effect("runs Process Pipeline execution unbounded when requested", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const state = {
        active: 0,
        maxActive: 0,
      };
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Unbounded article 1" },
            },
            {
              identityKey: "article-2",
              version: "source-version-1",
              item: { title: "Unbounded article 2" },
            },
            {
              identityKey: "article-3",
              version: "source-version-1",
              item: { title: "Unbounded article 3" },
            },
            {
              identityKey: "article-4",
              version: "source-version-1",
              item: { title: "Unbounded article 4" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(),
        process: () =>
          Effect.gen(function* () {
            state.active += 1;
            state.maxActive = Math.max(state.maxActive, state.active);
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Effect.sleep("1 second");
            state.active -= 1;
          }),
      });

      const fiber = yield* runMigration(definition, {
        execution: { process: { concurrency: "unbounded" } },
      }).pipe(Effect.forkChild);

      yield* Deferred.await(firstStarted);
      yield* TestClock.adjust("500 millis");

      expect(state.maxActive).toBe(4);

      yield* TestClock.adjust("2 seconds");
      const summary = yield* Fiber.join(fiber);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 4,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
    })
  );

  it.effect(
    "rejects invalid Process Pipeline concurrency before opening a run",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        let processCalled = false;

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Invalid concurrency article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Effect.sync(() => {
              processCalled = true;
            }),
        });

        const error = yield* Effect.flip(
          runMigration(definition, {
            execution: { process: { concurrency: 0 } },
          })
        );

        expect(error).toBeInstanceOf(MigrationRuntimeError);
        expect(error.message).toBe("Run request contains invalid input");
        expect(processCalled).toBe(false);
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(storeState.itemStates.size).toBe(0);
      })
  );

  it.effect("fails a progress-only Process that stages a tracking record", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Unexpected tracking record",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () =>
          Tracking.setRecord({
            entryId: "entry-article-1",
            locale: "en-US",
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("failed");
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({
            kind: "tracking",
            message:
              "Tracking record was staged without a Tracking Record Contract",
            details: expect.arrayContaining([
              {
                path: "stagedRecords",
                message:
                  "Expected no staged tracking records without a Tracking Record Contract, received 1",
              },
            ]),
          }),
        })
      );
    })
  );

  it.effect(
    "persists a schema-valid tracking record for a record-backed Process",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Tracked process",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: (source) =>
            Tracking.setRecord({
              entryId: `entry-${source.identity.encoded}`,
              locale: "en-US",
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(
          storeState.migrationContracts.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            trackingRecordContractId: tracking.id,
            trackingRecordContractFingerprint: tracking.fingerprint,
          })
        );

        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(itemState).toEqual(
          expect.objectContaining({
            status: "migrated",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
            trackingRecord: {
              entryId: "entry-article-1",
              locale: "en-US",
            },
          })
        );
      })
  );

  it.effect(
    "fails a successful record-backed Process that stages no tracking record",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Missing tracking record" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: () => Effect.void,
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "tracking",
              message:
                "Tracking Record Contract requires exactly one staged record",
              details: expect.arrayContaining([
                {
                  path: "trackingRecordContractId",
                  message: tracking.id,
                },
                {
                  path: "trackingRecordContractFingerprint",
                  message: tracking.fingerprint,
                },
                {
                  path: "stagedRecords",
                  message:
                    "Expected exactly one staged tracking record, received 0",
                },
              ]),
            }),
          })
        );
      })
  );

  it.effect(
    "fails a successful record-backed Process that stages multiple tracking records",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Multiple tracking records" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: () =>
            Effect.gen(function* () {
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: "en-US",
              });
              yield* Tracking.setRecord({
                entryId: "entry-article-1-copy",
                locale: "en-US",
              });
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "tracking",
              message:
                "Tracking Record Contract requires exactly one staged record",
              details: expect.arrayContaining([
                {
                  path: "stagedRecords",
                  message:
                    "Expected exactly one staged tracking record, received 2",
                },
              ]),
            }),
          })
        );
      })
  );

  it.effect(
    "fails a successful record-backed Process that stages a schema-invalid tracking record",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Invalid tracking record" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: () =>
            Tracking.setRecord({
              entryId: 123,
              locale: "en-US",
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "tracking",
              message: "Tracking record did not match Tracking Record Contract",
              details: expect.arrayContaining([
                {
                  path: "trackingRecordContractId",
                  message: tracking.id,
                },
              ]),
            }),
          })
        );
      })
  );

  it.effect(
    "does not expose a staged tracking record from a failed Process",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after staging record",
        };
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Failed tracking record" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: () =>
            Effect.gen(function* () {
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: "en-US",
              });
              return yield* Effect.fail(processError);
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "process",
              message: "Process failed after staging record",
            }),
          })
        );
        expect(itemState).not.toHaveProperty("trackingRecord");
      })
  );

  it.effect(
    "persists helper-authored process journal entries when a later Process step fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestination.makeEntries({
          contentType: "article",
          fields: ArticleEntryFields,
        });
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after destination work",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Journaled article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.gen(function* () {
              yield* destination.entries.upsert({
                title: source.item.title,
              });
              return yield* Effect.fail(processError);
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 0,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });

        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            lastRunId: summary.runId,
          })
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];
        expect(journalEntries).toHaveLength(1);

        const entry = journalEntries[0];
        if (entry === undefined) {
          throw new Error("Expected one destination journal entry");
        }

        expect(destination.changes.entryUpserted.is(entry)).toBe(true);

        const decodedEntry =
          yield* destination.changes.entryUpserted.decode(entry);

        expect(decodedEntry.sequence).toBe(0);
        expectTypeOf(decodedEntry.value).toEqualTypeOf<
          InMemoryEntryUpsertedChange<"article", ArticleEntryFields>
        >();
        expect(decodedEntry.value).toEqual({
          contentType: "article",
          entryId: "entry:article:article-1",
          entryVersion: "version:1",
          fields: {
            title: "Journaled article",
          },
          published: false,
          sourceIdentity: "article-1",
        });
      })
  );

  it.effect(
    "persists process-authored diagnostic journal entries when the Process fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after diagnostic",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Diagnostic article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.gen(function* () {
              yield* Tracking.logDiagnostic({
                severity: "error",
                message: "Could not normalize article before destination work",
                details: {
                  sourceIdentity: source.identity.encoded,
                  title: source.item.title,
                },
              });
              return yield* Effect.fail(processError);
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("failed");
        expect(journalEntries).toEqual([
          {
            kind: "diagnostic",
            sequence: 0,
            severity: "error",
            message: "Could not normalize article before destination work",
            details: {
              sourceIdentity: "article-1",
              title: "Diagnostic article",
            },
          },
        ]);
      })
  );

  it.effect(
    "rejects invalid diagnostic severity before appending to the process journal",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Invalid diagnostic article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Tracking.logDiagnostic({
              severity: "fatal" as never,
              message: "Invalid diagnostic severity",
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              errorTag: "SchemaError",
              kind: "process",
            }),
          })
        );
        expect(itemState).not.toHaveProperty("journal");
      })
  );

  it.effect(
    "rejects missing diagnostic severity before appending to the process journal",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Missing diagnostic severity article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Tracking.logDiagnostic({
              message: "Missing diagnostic severity",
            } as never),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              errorTag: "SchemaError",
              kind: "process",
            }),
          })
        );
        expect(itemState).not.toHaveProperty("journal");
      })
  );

  it.effect(
    "persists diagnostics when log-level configuration would suppress the matching observability log",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after suppressed diagnostic",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Suppressed diagnostic article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Effect.gen(function* () {
              yield* Tracking.logDiagnostic({
                severity: "info",
                message: "Suppressed observability diagnostic",
              });
              return yield* Effect.fail(processError);
            }),
        });

        yield* runMigration(definition).pipe(
          Effect.provideService(MinimumLogLevel, "Error")
        );

        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(journalEntries).toEqual([
          {
            kind: "diagnostic",
            sequence: 0,
            severity: "info",
            message: "Suppressed observability diagnostic",
          },
        ]);
      })
  );

  it.effect(
    "does not persist ordinary Effect logs or Console output as diagnostics",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after ordinary logs",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Logged article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Effect.gen(function* () {
              yield* Effect.logError("Ordinary Effect log");
              yield* Console.log("Ordinary Console output");
              return yield* Effect.fail(processError);
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              message: "Process failed after ordinary logs",
            }),
          })
        );
        expect(itemState).not.toHaveProperty("journal");
      })
  );

  it.effect(
    "persists helper-authored process journal entries when the Process succeeds",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestination.makeEntries({
          contentType: "article",
          fields: ArticleEntryFields,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Migrated article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            destination.entries.upsert({
              title: source.item.title,
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const journalEntries =
          itemState?.status === "migrated"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("succeeded");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "migrated",
          })
        );
        expect(journalEntries).toHaveLength(1);
        expect(journalEntries[0]).toEqual(
          expect.objectContaining({
            descriptorId: destination.changes.entryUpserted.id,
            sequence: 0,
          })
        );
      })
  );

  it.effect(
    "persists helper-authored process journal entries when the Process later skips",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestination.makeEntries({
          contentType: "article",
          fields: ArticleEntryFields,
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Skipped article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.gen(function* () {
              yield* destination.entries.upsert({
                title: source.item.title,
              });
              return yield* skipItem("No longer eligible");
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const journalEntries =
          itemState?.status === "skipped"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("succeeded");
        expect(itemState).toEqual(
          expect.objectContaining({
            skipReason: "No longer eligible",
            status: "skipped",
          })
        );
        expect(journalEntries).toHaveLength(1);
        expect(journalEntries[0]).toEqual(
          expect.objectContaining({
            descriptorId: destination.changes.entryUpserted.id,
            sequence: 0,
          })
        );
      })
  );

  it.effect(
    "records a helper diagnostic without a success change when the helper fails before the destination effect completes",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestination.makeEntries({
          contentType: "article",
          fields: ArticleEntryFields,
          transientFailures: {
            execute: 1,
          },
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Failed helper article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            destination.entries.upsert({
              title: source.item.title,
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
          })
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(journalEntries).toEqual([
          {
            kind: "diagnostic",
            sequence: 0,
            severity: "error",
            message: "In-memory destination execute failed transiently",
            details: {
              contentType: "article",
              operation: "entries.upsert",
              sourceIdentity: "article-1",
            },
          },
        ]);
        expect(
          journalEntries.some((entry) =>
            destination.changes.entryUpserted.is(entry)
          )
        ).toBe(false);
      })
  );

  it.effect(
    "allows inline retry of a destination helper and records one successful change",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestination.makeEntries({
          contentType: "article",
          fields: ArticleEntryFields,
          transientFailures: {
            execute: 1,
          },
        });
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after retry",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Retried article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.gen(function* () {
              yield* destination.entries
                .upsert({
                  title: source.item.title,
                })
                .pipe(Effect.retry(Schedule.recurs(1)));
              return yield* Effect.fail(processError);
            }),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];

        expect(summary.status).toBe("failed");
        expect(journalEntries).toHaveLength(2);
        expect(journalEntries[0]).toEqual({
          kind: "diagnostic",
          sequence: 0,
          severity: "error",
          message: "In-memory destination execute failed transiently",
          details: {
            contentType: "article",
            operation: "entries.upsert",
            sourceIdentity: "article-1",
          },
        });

        const upsertedChanges = journalEntries.filter(
          destination.changes.entryUpserted.is
        );

        expect(upsertedChanges).toHaveLength(1);
        expect(upsertedChanges[0]).toEqual(
          expect.objectContaining({
            descriptorId: destination.changes.entryUpserted.id,
            sequence: 1,
          })
        );
      })
  );

  it.effect(
    "preserves repeated same-descriptor change payloads in journal order",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const destination = InMemoryDestination.makeEntries({
          contentType: "article",
          fields: ArticleEntryFields,
        });
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after repeated destination work",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "First title",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.gen(function* () {
              yield* destination.entries.upsert({
                title: source.item.title,
              });
              yield* destination.entries.upsert({
                title: "Second title",
              });
              return yield* Effect.fail(processError);
            }),
        });

        yield* runMigration(definition);

        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const journalEntries =
          itemState?.status === "failed"
            ? (itemState.journal?.process.entries ?? [])
            : [];
        const upsertedChanges = yield* Effect.forEach(
          journalEntries.filter(destination.changes.entryUpserted.is),
          destination.changes.entryUpserted.decode
        );

        expect(upsertedChanges.map((entry) => entry.sequence)).toEqual([0, 1]);
        expect(upsertedChanges.map((entry) => entry.value.fields)).toEqual([
          { title: "First title" },
          { title: "Second title" },
        ]);
        expect(
          upsertedChanges.map((entry) => entry.value.entryVersion)
        ).toEqual(["version:1", "version:2"]);
      })
  );

  it.effect(
    "validates destination change payloads before appending them to the process journal",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const malformedChange = DestinationChangeDescriptor.make(
          "test.malformed-change",
          Schema.Struct({
            id: Schema.String,
          })
        );

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Malformed change",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Tracking.recordChange(malformedChange, {
              id: 123,
            } as never),
        });

        const summary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              errorTag: "SchemaError",
              kind: "process",
            }),
          })
        );
        expect(itemState).not.toHaveProperty("journal");
      })
  );

  it.effect(
    "decodes transformed descriptor payloads instead of narrowing encoded journal values",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const QuantityChange = Schema.Struct({
          quantity: Schema.NumberFromString,
        });
        type QuantityChange = typeof QuantityChange.Type;
        const quantityChanged = DestinationChangeDescriptor.make(
          "test.quantity-changed",
          QuantityChange
        );
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "process-failed",
          message: "Process failed after transformed tracking record",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Transformed tracking",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () =>
            Effect.gen(function* () {
              yield* Tracking.recordChange(quantityChanged, {
                quantity: 7,
              });
              return yield* Effect.fail(processError);
            }),
        });

        yield* runMigration(definition);

        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        const entry =
          itemState?.status === "failed"
            ? itemState.journal?.process.entries[0]
            : undefined;

        if (entry === undefined) {
          throw new Error("Expected one transformed destination journal entry");
        }

        if (!quantityChanged.is(entry)) {
          throw new Error("Expected transformed destination journal entry");
        }

        expect(entry.value).toEqual({
          quantity: "7",
        });

        const decodedEntry = yield* quantityChanged.decode(entry);

        expectTypeOf(decodedEntry.value).toEqualTypeOf<QuantityChange>();
        expect(decodedEntry.value).toEqual({
          quantity: 7,
        });
      })
  );

  it.effect("records skipped item state from a Process Pipeline", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Skip me",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.fail(skipItem("Not ready")),
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
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "skipped",
          skipReason: "Not ready",
          sourceVersion: "source-version-1",
          lastRunId: summary.runId,
        })
      );
    })
  );

  it.effect("records failed item state from a Process Pipeline", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processError: PipelineFailureTestError = {
        _tag: "PipelineFailureTestError",
        code: "process-failed",
        message: "Process failed",
      };

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Fail me",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.fail(processError),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("failed");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
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
            kind: "process",
            errorTag: "PipelineFailureTestError",
            message: "Process failed",
          }),
        })
      );
    })
  );

  it.effect("treats progress-only Process Pipeline state as unchanged", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Run once",
              },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      const firstSummary = yield* runMigration(definition);
      const secondSummary = yield* runMigration(definition);

      expect(firstSummary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(secondSummary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 0,
        unchanged: 1,
        needsUpdate: 0,
      });
      expect(processCalls).toEqual(["article-1"]);
    })
  );

  it.effect(
    "blocks execution before source reads when existing item state uses a different source identity contract",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const changedSourceState = InMemorySourcePlugin.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const process = () => Effect.void;
        const original = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Original contract",
                },
              },
            ],
          }),
          store,
          process,
        });

        yield* runMigration(original);

        const ChangedArticleSourceIdentity = SourceIdentity.make({
          id: "test-article@v1",
          schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
        });
        const changed = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            identity: ChangedArticleSourceIdentity,
            sourceSchema: ArticleSource,
            state: changedSourceState,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Changed contract",
                },
              },
            ],
          }),
          store,
          process,
        });

        const error = yield* Effect.flip(runMigration(changed));

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition source contract changed",
          })
        );
        expect(changedSourceState.readAttempts).toBe(0);
        expect(changedSourceState.readByIdentityAttempts).toBe(0);
      })
  );

  it.effect(
    "blocks execution before source reads when item state exists without a stored Migration Contract",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sourceState = InMemorySourcePlugin.makeState();
        const store = InMemoryMigrationStore.layer(storeState);

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-1"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            lastRunId: toMigrationRunId("run-previous"),
            sourceIdentity: articleSourceIdentity("article-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated",
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          }
        );

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            state: sourceState,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Existing state",
                },
              },
            ],
          }),
          store,
          process: () => Effect.void,
        });

        const error = yield* Effect.flip(runMigration(definition));

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition source contract changed",
          })
        );
        expect(sourceState.readAttempts).toBe(0);
        expect(sourceState.readByIdentityAttempts).toBe(0);
        expect(storeState.migrationContracts.size).toBe(0);
      })
  );

  it.effect(
    "blocks execution before source reads when existing item state uses a different tracking record contract",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const changedSourceState = InMemorySourcePlugin.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const originalTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const original = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Original tracking contract",
                },
              },
            ],
          }),
          store,
          tracking: originalTracking,
          process: (source) =>
            Tracking.setRecord({
              entryId: `entry-${source.identity.encoded}`,
              locale: "en-US",
            }),
        });

        yield* runMigration(original);

        const changedTracking = Tracking.record({
          id: "article-entry@v2",
          schema: ArticleTrackingRecord,
        });
        const changed = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            state: changedSourceState,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Changed tracking contract",
                },
              },
            ],
          }),
          store,
          tracking: changedTracking,
          process: (source) =>
            Tracking.setRecord({
              entryId: `entry-${source.identity.encoded}`,
              locale: "en-US",
            }),
        });

        const error = yield* Effect.flip(runMigration(changed));

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition tracking record contract changed",
          })
        );
        expect(changedSourceState.readAttempts).toBe(0);
        expect(changedSourceState.readByIdentityAttempts).toBe(0);
        expect(
          storeState.migrationContracts.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            trackingRecordContractId: originalTracking.id,
            trackingRecordContractFingerprint: originalTracking.fingerprint,
          })
        );
      })
  );

  it.effect(
    "blocks reference lookup when a non-dependency target tracking contract drifts",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const originalAuthorTracking = Tracking.record({
          id: "author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const originalAuthors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "author-version-1",
                item: { title: "Original author" },
              },
            ],
          }),
          store,
          tracking: originalAuthorTracking,
          process: (source) =>
            Tracking.setRecord({
              entryId: `entry-${source.identity.encoded}`,
              locale: "en-US",
            }),
        });

        yield* runMigration(originalAuthors);

        const changedAuthorTracking = Tracking.record({
          id: "author-entry@v2",
          schema: ArticleTrackingRecord,
        });
        const changedAuthors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: changedAuthorTracking,
          process: () => Effect.void,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with drifted author lookup" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definition: changedAuthors,
                sourceIdentityKey: "author-1",
              });

              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, changedAuthors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "process",
              message: "Migration Definition tracking record contract changed",
            }),
          })
        );
        expect(
          storeState.migrationContracts.get(toMigrationDefinitionId("authors"))
        ).toEqual(
          expect.objectContaining({
            trackingRecordContractId: originalAuthorTracking.id,
            trackingRecordContractFingerprint:
              originalAuthorTracking.fingerprint,
          })
        );
      })
  );

  it.effect(
    "validates every ordered lookup target before returning a reference",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const staffTracking = Tracking.record({
          id: "staff-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const guestTracking = Tracking.record({
          id: "guest-author-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const staffAuthors = defineMigration({
          id: "staff-authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "staff-version-1",
                item: { title: "Staff author" },
              },
            ],
          }),
          store,
          tracking: staffTracking,
          process: (source) =>
            Tracking.setRecord({
              entryId: `entry-staff-${source.identity.encoded}`,
              locale: "staff",
            }),
        });
        const guestAuthors = defineMigration({
          id: "guest-authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "guest-version-1",
                item: { title: "Guest author" },
              },
            ],
          }),
          store,
          tracking: guestTracking,
          process: (source) =>
            Tracking.setRecord({
              entryId: `entry-guest-${source.identity.encoded}`,
              locale: "guest",
            }),
        });

        yield* runMigration(staffAuthors);
        yield* runMigration(guestAuthors);

        const changedGuestTracking = Tracking.record({
          id: "guest-author-entry@v2",
          schema: ArticleTrackingRecord,
        });
        const changedGuestAuthors = defineMigration({
          id: "guest-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: changedGuestTracking,
          process: () => Effect.void,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with ordered drifted author lookup" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                targets: [
                  references.target(staffAuthors, "author-1"),
                  references.target(changedGuestAuthors, "author-1"),
                ],
              });

              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, staffAuthors, changedGuestAuthors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "process",
              message: "Migration Definition tracking record contract changed",
            }),
          })
        );
      })
  );

  it.effect(
    "looks up schema-validated tracking records from record-backed Process definitions",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const authorTracking = Tracking.record({
          id: "author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const authorSourceIdentity = articleSourceIdentity("author-1");
        let observedAuthorReference: MigrationReference<ArticleTrackingRecord> | null =
          null;

        seedTrackingMigrationContract(storeState, "authors", authorTracking);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("authors", "author-1"),
          {
            definitionId: toMigrationDefinitionId("authors"),
            sourceIdentity: authorSourceIdentity,
            sourceVersion: toSourceVersion("author-version-1"),
            lastRunId: toMigrationRunId("run-authors"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
            trackingRecord: {
              entryId: "entry-author-1",
              locale: "en-US",
            },
          }
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: authorTracking,
          process: () => Effect.void,
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with tracked author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definition: authors,
                sourceIdentityKey: "author-1",
              });
              expectTypeOf(
                author
              ).toEqualTypeOf<MigrationReference<ArticleTrackingRecord> | null>();
              if (author !== null) {
                expectTypeOf(
                  author.trackingRecord
                ).toEqualTypeOf<ArticleTrackingRecord>();
              }
              observedAuthorReference = author;
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(observedAuthorReference).toEqual({
          definitionId: toMigrationDefinitionId("authors"),
          sourceIdentity: authorSourceIdentity.encoded,
          status: "migrated",
          trackingRecord: {
            entryId: "entry-author-1",
            locale: "en-US",
          },
        });
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              entryId: "entry-article-1",
              locale: "en-US",
            },
          })
        );
      })
  );

  it.effect("caches lookup contract validation by target definition", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const authorDefinitionId = toMigrationDefinitionId("authors");
      let authorGetMigrationContractAttempts = 0;
      let authorListItemStateAttempts = 0;
      const store = Layer.effect(
        MigrationStore,
        Effect.gen(function* () {
          const baseStore = yield* MigrationStore;

          return {
            ...baseStore,
            getMigrationContract: (definitionId) =>
              Effect.sync(() => {
                if (definitionId === authorDefinitionId) {
                  authorGetMigrationContractAttempts += 1;
                }
              }).pipe(
                Effect.flatMap(() =>
                  baseStore.getMigrationContract(definitionId)
                )
              ),
            listItemStates: (definitionId) =>
              Effect.sync(() => {
                if (definitionId === authorDefinitionId) {
                  authorListItemStateAttempts += 1;
                }
              }).pipe(
                Effect.flatMap(() => baseStore.listItemStates(definitionId))
              ),
          };
        })
      ).pipe(Layer.provide(InMemoryMigrationStore.layer(storeState)));
      const authorTracking = Tracking.record({
        id: "author-entry@v1",
        schema: ArticleTrackingRecord,
      });
      const articleTracking = Tracking.record({
        id: "article-entry@v1",
        schema: ArticleTrackingRecord,
      });

      seedTrackingMigrationContract(storeState, "authors", authorTracking);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("authors", "author-1"),
        {
          definitionId: authorDefinitionId,
          sourceIdentity: articleSourceIdentity("author-1"),
          sourceVersion: toSourceVersion("author-version-1"),
          lastRunId: toMigrationRunId("run-authors"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
          trackingRecord: {
            entryId: "entry-author-1",
            locale: "en-US",
          },
        }
      );

      const authors = defineMigration({
        id: "authors",
        source: makeTestInMemorySource({
          items: [],
        }),
        store,
        tracking: authorTracking,
        process: () => Effect.void,
      });
      const articles = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Article with repeated author lookup" },
            },
          ],
        }),
        store,
        tracking: articleTracking,
        process: () =>
          Effect.gen(function* () {
            const references = yield* MigrationReferenceLookup;
            const firstAuthor = yield* references.lookup({
              definition: authors,
              sourceIdentityKey: "author-1",
            });
            const secondAuthor = yield* references.lookup({
              definition: authors,
              sourceIdentityKey: "author-1",
            });

            yield* Tracking.setRecord({
              entryId: "entry-article-1",
              locale:
                secondAuthor?.trackingRecord.locale ??
                firstAuthor?.trackingRecord.locale ??
                "unknown",
            });
          }),
      });

      const summary = yield* runMigrations({
        definitions: [articles, authors],
        definitionIds: ["articles"],
      });

      expect(summary.status).toBe("succeeded");
      expect(authorGetMigrationContractAttempts).toBe(1);
      expect(authorListItemStateAttempts).toBe(0);
    })
  );

  it.effect(
    "uses the first migrated tracking record from ordered Migration Definition lookups",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const staffTracking = Tracking.record({
          id: "staff-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const guestTracking = Tracking.record({
          id: "guest-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        seedTrackingMigrationContract(
          storeState,
          "staff-authors",
          staffTracking
        );
        seedTrackingMigrationContract(
          storeState,
          "guest-authors",
          guestTracking
        );
        for (const [definitionId, entryId, locale] of [
          ["staff-authors", "entry-staff-author-1", "staff"],
          ["guest-authors", "entry-guest-author-1", "guest"],
        ] as const) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(definitionId, "author-1"),
            {
              definitionId: toMigrationDefinitionId(definitionId),
              sourceIdentity: articleSourceIdentity("author-1"),
              sourceVersion: toSourceVersion(`${definitionId}-version-1`),
              lastRunId: toMigrationRunId(`run-${definitionId}`),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              status: "migrated",
              trackingRecord: {
                entryId,
                locale,
              },
            }
          );
        }

        const staffAuthors = defineMigration({
          id: "staff-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: staffTracking,
          process: () => Effect.void,
        });
        const guestAuthors = defineMigration({
          id: "guest-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: guestTracking,
          process: () => Effect.void,
        });
        let observedAuthorReference: MigrationReference<ArticleTrackingRecord> | null =
          null;
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with ordered tracked author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                targets: [
                  references.target(staffAuthors, "author-1"),
                  references.target(guestAuthors, "author-1"),
                ],
              });

              observedAuthorReference = author;
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, guestAuthors, staffAuthors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(observedAuthorReference).toEqual({
          definitionId: toMigrationDefinitionId("staff-authors"),
          sourceIdentity: "author-1",
          status: "migrated",
          trackingRecord: {
            entryId: "entry-staff-author-1",
            locale: "staff",
          },
        });
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              entryId: "entry-article-1",
              locale: "staff",
            },
          })
        );
      })
  );

  it.effect(
    "looks up ordered targets with heterogeneous Source Identity schemas",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const staffTracking = Tracking.record({
          id: "staff-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const guestTracking = Tracking.record({
          id: "guest-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const PublisherAuthorIdentity = SourceIdentity.make({
          id: "publisher-author@v1",
          schema: SourceIdentity.tuple([
            SourceIdentity.part("publisherId", Schema.NonEmptyString),
            SourceIdentity.part("authorId", Schema.NonEmptyString),
          ]),
        });
        const guestAuthorIdentityKey = ["publisher-1", "author-1"] as const;
        const guestSourceIdentity = SourceIdentity.fromKey(
          PublisherAuthorIdentity,
          guestAuthorIdentityKey
        );

        seedTrackingMigrationContract(
          storeState,
          "guest-authors",
          guestTracking,
          PublisherAuthorIdentity
        );
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            "guest-authors",
            guestSourceIdentity.encoded
          ),
          {
            definitionId: toMigrationDefinitionId("guest-authors"),
            sourceIdentity: guestSourceIdentity,
            sourceVersion: toSourceVersion("guest-author-version-1"),
            lastRunId: toMigrationRunId("run-guest-authors"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
            trackingRecord: {
              entryId: "entry-guest-author-1",
              locale: "guest",
            },
          }
        );

        const staffAuthors = defineMigration({
          id: "staff-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: staffTracking,
          process: () => Effect.void,
        });
        const guestAuthors = defineMigration({
          id: "guest-authors",
          source: InMemorySourcePlugin.make({
            identity: PublisherAuthorIdentity,
            sourceSchema: ArticleSource,
            items: [],
          }),
          store,
          tracking: guestTracking,
          process: () => Effect.void,
        });
        let observedAuthorReference: MigrationReference<ArticleTrackingRecord> | null =
          null;
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with heterogeneous tracked author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                targets: [
                  references.target(staffAuthors, "author-1"),
                  references.target(guestAuthors, guestAuthorIdentityKey),
                ],
              });

              observedAuthorReference = author;
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, staffAuthors, guestAuthors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(observedAuthorReference).toEqual({
          definitionId: toMigrationDefinitionId("guest-authors"),
          sourceIdentity: guestSourceIdentity.encoded,
          status: "migrated",
          trackingRecord: {
            entryId: "entry-guest-author-1",
            locale: "guest",
          },
        });
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              entryId: "entry-article-1",
              locale: "guest",
            },
          })
        );
      })
  );

  it.effect(
    "rejects record-backed reference lookup when migrated state has no tracking record",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const authorTracking = Tracking.record({
          id: "author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const authorSourceIdentity = articleSourceIdentity("author-1");

        seedTrackingMigrationContract(storeState, "authors", authorTracking);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("authors", "author-1"),
          {
            definitionId: toMigrationDefinitionId("authors"),
            sourceIdentity: authorSourceIdentity,
            sourceVersion: toSourceVersion("author-version-1"),
            lastRunId: toMigrationRunId("run-authors"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
          }
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: authorTracking,
          process: () => Effect.void,
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with corrupt tracked author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              yield* references.lookup({
                definition: authors,
                sourceIdentityKey: "author-1",
              });
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: "en-US",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "process",
              message:
                "Migration Reference tracking record is missing from migrated item state",
            }),
          })
        );
      })
  );

  it.effect("creates lookup stubs from the first ordered target", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const staffTracking = Tracking.record({
        id: "staff-author-entry@v1",
        schema: ArticleTrackingRecord,
      });
      const guestTracking = Tracking.record({
        id: "guest-author-entry@v1",
        schema: ArticleTrackingRecord,
      });
      const articleTracking = Tracking.record({
        id: "article-entry@v1",
        schema: ArticleTrackingRecord,
      });
      let staffStubCalls = 0;
      let guestStubCalls = 0;

      const staffAuthors = defineMigration({
        id: "staff-authors",
        source: makeTestInMemorySource({
          items: [],
        }),
        store,
        tracking: staffTracking,
        stub: ({ sourceIdentity }) =>
          Effect.gen(function* () {
            staffStubCalls += 1;
            yield* Tracking.setRecord({
              entryId: `entry-staff-${sourceIdentity}`,
              locale: "staff",
            });
          }),
        process: () => Effect.void,
      });
      const guestAuthors = defineMigration({
        id: "guest-authors",
        source: makeTestInMemorySource({
          items: [],
        }),
        store,
        tracking: guestTracking,
        stub: ({ sourceIdentity }) =>
          Effect.gen(function* () {
            guestStubCalls += 1;
            yield* Tracking.setRecord({
              entryId: `entry-guest-${sourceIdentity}`,
              locale: "guest",
            });
          }),
        process: () => Effect.void,
      });
      let observedAuthorReference: MigrationReference<ArticleTrackingRecord> | null =
        null;
      const articles = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Article with ordered stub author" },
            },
          ],
        }),
        store,
        tracking: articleTracking,
        process: () =>
          Effect.gen(function* () {
            const references = yield* MigrationReferenceLookup;
            const author = yield* references.lookup({
              targets: [
                references.target(staffAuthors, "author-1"),
                references.target(guestAuthors, "author-1"),
              ],
              stub: true,
            });

            observedAuthorReference = author;
            yield* Tracking.setRecord({
              entryId: "entry-article-1",
              locale: author?.trackingRecord.locale ?? "unknown",
            });
          }),
      });

      const summary = yield* runMigrations({
        definitions: [articles, guestAuthors, staffAuthors],
        definitionIds: ["articles"],
      });

      expect(summary.status).toBe("succeeded");
      expect(staffStubCalls).toBe(1);
      expect(guestStubCalls).toBe(0);
      expect(observedAuthorReference).toEqual({
        definitionId: toMigrationDefinitionId("staff-authors"),
        sourceIdentity: "author-1",
        status: "needs-update",
        trackingRecord: {
          entryId: "entry-staff-author-1",
          locale: "staff",
        },
      });
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("staff-authors", "author-1")
        )
      ).toEqual(
        expect.objectContaining({
          status: "needs-update",
          trackingRecord: {
            entryId: "entry-staff-author-1",
            locale: "staff",
          },
        })
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("guest-authors", "author-1")
        )
      ).toBeUndefined();
    })
  );

  it.effect(
    "creates lookup stubs from an explicitly selected ordered target",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const staffTracking = Tracking.record({
          id: "staff-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const guestTracking = Tracking.record({
          id: "guest-author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        let staffStubCalls = 0;
        let guestStubCalls = 0;

        const staffAuthors = defineMigration({
          id: "staff-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: staffTracking,
          stub: ({ sourceIdentity }) =>
            Effect.gen(function* () {
              staffStubCalls += 1;
              yield* Tracking.setRecord({
                entryId: `entry-staff-${sourceIdentity}`,
                locale: "staff",
              });
            }),
          process: () => Effect.void,
        });
        const guestAuthors = defineMigration({
          id: "guest-authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: guestTracking,
          stub: ({ sourceIdentity }) =>
            Effect.gen(function* () {
              guestStubCalls += 1;
              yield* Tracking.setRecord({
                entryId: `entry-guest-${sourceIdentity}`,
                locale: "guest",
              });
            }),
          process: () => Effect.void,
        });
        let observedAuthorReference: MigrationReference<ArticleTrackingRecord> | null =
          null;
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with explicit ordered stub author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                targets: [
                  references.target(staffAuthors, "author-1"),
                  references.target(guestAuthors, "author-1"),
                ],
                stub: { definition: guestAuthors },
              });

              observedAuthorReference = author;
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, staffAuthors, guestAuthors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(staffStubCalls).toBe(0);
        expect(guestStubCalls).toBe(1);
        expect(observedAuthorReference).toEqual({
          definitionId: toMigrationDefinitionId("guest-authors"),
          sourceIdentity: "author-1",
          status: "needs-update",
          trackingRecord: {
            entryId: "entry-guest-author-1",
            locale: "guest",
          },
        });
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("staff-authors", "author-1")
          )
        ).toBeUndefined();
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("guest-authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            trackingRecord: {
              entryId: "entry-guest-author-1",
              locale: "guest",
            },
          })
        );
      })
  );

  it.effect(
    "creates reference stubs with destination work for record-backed Process definitions",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const authorDestination = InMemoryDestination.makeEntries({
          contentType: "author",
          fields: ArticleEntryFields,
        });
        const authorTracking = Tracking.record({
          id: "author-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          tracking: authorTracking,
          stub: ({ sourceIdentity }) =>
            Effect.gen(function* () {
              const entry = yield* authorDestination.entries.upsert({
                title: `Stub ${sourceIdentity}`,
              });

              yield* Tracking.setRecord({
                entryId: entry.entryId,
                locale: "en-US",
              });
            }),
          process: () => Effect.void,
        });
        let observedAuthorReference: MigrationReference<ArticleTrackingRecord> | null =
          null;
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with missing tracked author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              const author = yield* references.lookup({
                definition: authors,
                sourceIdentityKey: "author-1",
                stub: true,
              });
              observedAuthorReference = author;
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: author?.trackingRecord.locale ?? "unknown",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              entryId: "entry-article-1",
              locale: "en-US",
            },
          })
        );
        expect(observedAuthorReference).toEqual({
          definitionId: toMigrationDefinitionId("authors"),
          sourceIdentity: "author-1",
          status: "needs-update",
          trackingRecord: {
            entryId: "entry:author:author-1",
            locale: "en-US",
          },
        });
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("authors", "author-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Migration Reference Stub requires update",
            trackingRecord: {
              entryId: "entry:author:author-1",
              locale: "en-US",
            },
          })
        );
        const authorState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("authors", "author-1")
        );
        const authorJournalEntries =
          authorState?.status === "needs-update"
            ? (authorState.journal?.process.entries ?? [])
            : [];
        expect(authorJournalEntries).toHaveLength(1);
        expect(authorJournalEntries[0]).toEqual(
          expect.objectContaining({
            descriptorId: authorDestination.changes.entryUpserted.id,
          })
        );
      })
  );

  it.effect("reuses a persisted reference stub for repeated lookup input", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const authorDestination = InMemoryDestination.makeEntries({
        contentType: "author",
        fields: ArticleEntryFields,
      });
      const authorTracking = Tracking.record({
        id: "author-entry@v1",
        schema: ArticleTrackingRecord,
      });
      const articleTracking = Tracking.record({
        id: "article-entry@v1",
        schema: ArticleTrackingRecord,
      });
      let stubCalls = 0;

      const authors = defineMigration({
        id: "authors",
        source: makeTestInMemorySource({
          items: [],
        }),
        store,
        tracking: authorTracking,
        stub: ({ sourceIdentity }) =>
          Effect.gen(function* () {
            stubCalls += 1;
            const entry = yield* authorDestination.entries.upsert({
              title: `Stub ${sourceIdentity}`,
            });

            yield* Tracking.setRecord({
              entryId: entry.entryId,
              locale: "en-US",
            });
          }),
        process: () => Effect.void,
      });
      const articles = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: {
                title: "Article with duplicate missing author lookups",
              },
            },
          ],
        }),
        store,
        tracking: articleTracking,
        process: () =>
          Effect.gen(function* () {
            const references = yield* MigrationReferenceLookup;
            const first = yield* references.lookup({
              definition: authors,
              sourceIdentityKey: "author-1",
              stub: true,
            });
            const second = yield* references.lookup({
              definition: authors,
              sourceIdentityKey: "author-1",
              stub: true,
            });

            expect(second).toEqual(first);
            yield* Tracking.setRecord({
              entryId: "entry-article-1",
              locale: second?.trackingRecord.locale ?? "unknown",
            });
          }),
      });

      const summary = yield* runMigrations({
        definitions: [articles, authors],
        definitionIds: ["articles"],
      });
      const authorState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("authors", "author-1")
      );
      const authorJournalEntries =
        authorState?.status === "needs-update"
          ? (authorState.journal?.process.entries ?? [])
          : [];

      expect(summary.status).toBe("succeeded");
      expect(authorState).toEqual(
        expect.objectContaining({
          status: "needs-update",
          trackingRecord: {
            entryId: "entry:author:author-1",
            locale: "en-US",
          },
        })
      );
      expect(authorJournalEntries).toHaveLength(1);
      expect(stubCalls).toBe(1);
    })
  );

  it.effect(
    "rejects reference lookup for progress-only Process definitions",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const articleTracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          process: () => Effect.void,
        });
        const articles = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with progress-only author" },
              },
            ],
          }),
          store,
          tracking: articleTracking,
          process: () =>
            Effect.gen(function* () {
              const references = yield* MigrationReferenceLookup;
              yield* references.lookup({
                definition: authors,
                sourceIdentityKey: "author-1",
              });
              yield* Tracking.setRecord({
                entryId: "entry-article-1",
                locale: "en-US",
              });
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({
              kind: "process",
              message:
                "Migration Reference Lookup requires referenced Migration Definition to declare a Tracking Record Contract",
            }),
          })
        );
      })
  );

  it.effect(
    "reprocesses migrated items when source version contract changes",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const changedSourceState = InMemorySourcePlugin.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const process = () => Effect.void;
        const originalVersionContract = makeSourceVersionContractFingerprint({
          kind: "field",
          field: "updatedAt",
        });
        const original = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            sourceVersionContractFingerprint: originalVersionContract,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Original version contract",
                },
              },
            ],
          }),
          store,
          process,
        });

        yield* runMigration(original);
        expect(
          storeState.migrationContracts.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentityContractFingerprint:
              ArticleSourceIdentity.fingerprint,
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            sourceVersionContractFingerprint: originalVersionContract,
          })
        );

        const changedVersionContract = makeSourceVersionContractFingerprint({
          kind: "field",
          field: "changedAt",
        });
        const changed = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            sourceVersionContractFingerprint: changedVersionContract,
            state: changedSourceState,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: "Changed version contract",
                },
              },
            ],
          }),
          store,
          process,
        });

        const summary = yield* runMigration(changed);

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(changedSourceState.readAttempts).toBe(1);
        expect(changedSourceState.readByIdentityAttempts).toBe(0);
        expect(
          storeState.migrationContracts.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentityContractFingerprint:
              ArticleSourceIdentity.fingerprint,
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-1")
          )
        ).toEqual(
          expect.objectContaining({
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint: changedVersionContract,
            status: "migrated",
          })
        );
      })
  );

  it.effect(
    "persists skipped Source Items without executing a destination effect",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  publish: false,
                  title: "Draft article",
                },
              },
              {
                identityKey: "article-2",
                version: "source-version-1",
                item: {
                  publish: true,
                  title: "Published article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.gen(function* () {
              if (!source.item.publish) {
                return yield* skipItem("Article is not published");
              }

              processCalls.push(source.identity.encoded);
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
        expect(processCalls).toEqual(["article-2"]);

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
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Draft article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (): Effect.Effect<void, StructuralSkipItem> =>
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
    "aggregates concurrent process failures and continues processing Source Items",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];
        const pipelineError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          message: "Article cannot be transformed",
          code: "missing-title",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: {
                  title: null,
                },
              },
              {
                identityKey: "article-2",
                version: "source-version-1",
                item: {
                  title: "Published article",
                },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            source.identity.encoded === "article-1"
              ? Effect.fail(pipelineError)
              : Effect.sync(() => {
                  processCalls.push(source.identity.encoded);
                }),
        });

        const summary = yield* runMigration(definition, {
          execution: { process: { concurrency: 2 } },
        });

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(processCalls).toEqual(["article-2"]);

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
              kind: "process",
              errorTag: "PipelineFailureTestError",
              message: "Article cannot be transformed",
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
              kind: "process",
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

  it.effect("wraps Source Cursor reads with Source Cursor Retry", () =>
    Effect.gen(function* () {
      const sourceState = InMemorySourcePlugin.makeState();
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          state: sourceState,
          transientFailures: { read: 1 },
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Retryable article" },
            },
          ],
        }),
        sourceCursorRetry: (effect) =>
          effect.pipe(Effect.retry(Schedule.recurs(1))),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(sourceState.readAttempts).toBe(2);
      expect(processCalls).toEqual(["article-1"]);
    })
  );

  it.effect("wraps Source Identity lookups with Source Lookup Retry", () =>
    Effect.gen(function* () {
      const sourceState = InMemorySourcePlugin.makeState();
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          state: sourceState,
          transientFailures: { readByIdentity: 1 },
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Retryable article" },
            },
          ],
        }),
        sourceLookupRetry: (effect) =>
          effect.pipe(Effect.retry(Schedule.recurs(1))),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentityKey: "article-1" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(sourceState.readByIdentityAttempts).toBe(2);
      expect(processCalls).toEqual(["article-1"]);
    })
  );

  it.effect("runs item mode from decoded composite source identity keys", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];
      const BusinessAddressSourceIdentity = SourceIdentity.make({
        id: "business-address@v1",
        schema: SourceIdentity.tuple([
          SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
          SourceIdentity.part("addressIndex", Schema.Number),
        ]),
      });

      const definition = defineMigration({
        id: "business-addresses",
        source: InMemorySourcePlugin.make({
          identity: BusinessAddressSourceIdentity,
          sourceSchema: ArticleSource,
          items: [
            {
              identityKey: ["bu-1", 1],
              version: "source-version-1",
              item: { title: "Address 1" },
            },
            {
              identityKey: ["bu-1", 2],
              version: "source-version-1",
              item: { title: "Address 2" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity.encoded);
          }),
      });

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentityKey: ["bu-1", 2] },
      });

      expect(summary.status).toBe("succeeded");
      expect(pipelineCalls).toEqual([JSON.stringify(["bu-1", 2])]);
    })
  );

  it.effect(
    "records cursor-discovered source payload validation failures as durable item failures",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const pipelineCalls: string[] = [];

        const definition = defineMigration({
          id: "articles",
          source: InMemorySourcePlugin.make({
            identity: ArticleSourceIdentity,
            sourceSchema: ArticleSource,
            items: [
              {
                identityKey: "article-invalid",
                version: "source-version-1",
                item: asArticleSource({ title: null }),
              },
              {
                identityKey: "article-valid",
                version: "source-version-1",
                item: { title: "Valid article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });

        const summary = yield* runMigration(definition);

        expect(summary.status).toBe("failed");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 1,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(pipelineCalls).toEqual(["article-valid"]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-invalid")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            sourceVersion: "source-version-1",
            error: expect.objectContaining({
              kind: "source",
              errorTag: "SourcePayloadSchemaError",
              message: "Source payload did not match Source Payload Schema",
              details: expect.arrayContaining([
                expect.objectContaining({
                  path: "title",
                  message: expect.stringContaining("Expected string"),
                }),
              ]),
            }),
          })
        );
      })
  );

  it.effect("validates source payloads before unchanged detection", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          identity: ArticleSourceIdentity,
          sourceSchema: ArticleSource,
          items: [
            {
              identityKey: "article-unchanged-invalid",
              version: "source-version-1",
              item: asArticleSource({ title: null }),
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity.encoded);
          }),
      });

      seedArticleMigrationContract(storeState);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey(
          "articles",
          "article-unchanged-invalid"
        ),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-unchanged-invalid"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("failed");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual([]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-unchanged-invalid"
          )
        )
      ).toEqual(
        expect.objectContaining({
          status: "failed",
          lastRunId: summary.runId,
          sourceVersion: "source-version-1",
          error: expect.objectContaining({
            kind: "source",
            errorTag: "SourcePayloadSchemaError",
          }),
        })
      );
    })
  );

  it.effect("bounds persisted source payload schema error details", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          identity: ArticleSourceIdentity,
          sourceSchema: ManyFieldSource,
          items: [
            {
              identityKey: "article-many-errors",
              version: "source-version-1",
              item: asManyFieldSource({}),
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
      });

      yield* runMigration(definition);

      const itemState = storeState.itemStates.get(
        InMemoryMigrationStore.itemStateKey("articles", "article-many-errors")
      );

      expect(itemState).toEqual(
        expect.objectContaining({
          status: "failed",
          error: expect.objectContaining({
            kind: "source",
            errorTag: "SourcePayloadSchemaError",
            details: expect.arrayContaining([
              expect.objectContaining({
                message: "1 additional schema issue(s) omitted",
              }),
            ]),
          }),
        })
      );
      if (itemState?.status !== "failed") {
        throw new Error("Expected failed item state to be persisted");
      }
      expect(itemState.error.details).toHaveLength(6);
    })
  );

  it.effect("validates targeted source identity lookup payloads", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          identity: ArticleSourceIdentity,
          sourceSchema: ArticleSource,
          items: [
            {
              identityKey: "article-target-invalid",
              version: "source-version-1",
              item: asArticleSource({ title: null }),
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            pipelineCalls.push(source.identity.encoded);
          }),
      });

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: {
          kind: "item",
          sourceIdentityKey: "article-target-invalid",
        },
      });

      expect(summary.status).toBe("failed");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 0,
        skipped: 0,
        failed: 1,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual([]);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-target-invalid"
          )
        )
      ).toEqual(
        expect.objectContaining({
          status: "failed",
          sourceVersion: "source-version-1",
          error: expect.objectContaining({
            kind: "source",
            errorTag: "SourcePayloadSchemaError",
          }),
        })
      );
    })
  );

  it.effect("passes decoded source payloads to the process pipeline", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const decodedPayloads: ArticleStatsSource[] = [];

      const definition = defineMigration({
        id: "articles",
        source: InMemorySourcePlugin.make({
          identity: ArticleSourceIdentity,
          sourceSchema: ArticleStatsSource,
          items: [
            {
              identityKey: "article-stats",
              version: "source-version-1",
              item: asArticleStatsSource({
                title: "  Decoded article  ",
                views: "42",
              }),
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            decodedPayloads.push(source.item);
          }),
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(decodedPayloads).toEqual([
        { title: "Decoded article", views: 42 },
      ]);
    })
  );

  it.effect("rejects non-positive in-memory Source batch sizes", () =>
    Effect.gen(function* () {
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          batchSize: 0,
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(),
        process: () => Effect.void,
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
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          batchSize: 2,
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
            {
              identityKey: "article-2",
              version: "source-version-1",
              item: { title: "Article 2" },
            },
            {
              identityKey: "article-3",
              version: "source-version-1",
              item: { title: "Article 3" },
            },
            {
              identityKey: "article-4",
              version: "source-version-1",
              item: { title: "Article 4" },
            },
            {
              identityKey: "article-5",
              version: "source-version-1",
              item: { title: "Article 5" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
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
      expect(processCalls).toEqual([
        "article-1",
        "article-2",
        "article-3",
        "article-4",
        "article-5",
      ]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual(
        encodedInMemoryCursor(4)
      );
      expect(storeState.sourceCursorCommits).toEqual([
        {
          definitionId: definition.id,
          cursor: encodedInMemoryCursor(2),
        },
        {
          definitionId: definition.id,
          cursor: encodedInMemoryCursor(4),
        },
      ]);
    })
  );

  it.effect(
    "emits Migration Progress events while processing Source Cursor Windows",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const events: MigrationProgressEvent[] = [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            batchSize: 2,
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article 1" },
              },
              {
                identityKey: "article-2",
                version: "source-version-1",
                item: { title: "Article 2" },
              },
              {
                identityKey: "article-3",
                version: "source-version-1",
                item: { title: "Article 3" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
        });

        const progressLayer = Layer.succeed(MigrationProgress, {
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        const summary = yield* runMigration(definition).pipe(
          Effect.provide(progressLayer)
        );

        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 3,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(events.map((event) => event.kind)).toEqual([
          "run-started",
          "definition-started",
          "source-item-completed",
          "source-item-completed",
          "source-cursor-window-completed",
          "source-item-completed",
          "source-cursor-window-completed",
          "definition-completed",
          "run-completed",
        ]);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "source-cursor-window-completed",
              definitionId: definition.id,
              counts: {
                migrated: 2,
                skipped: 0,
                failed: 0,
                unchanged: 0,
                needsUpdate: 0,
              },
              itemsRead: 2,
            }),
            expect.objectContaining({
              kind: "definition-completed",
              definitionId: definition.id,
              status: "succeeded",
              counts: {
                migrated: 3,
                skipped: 0,
                failed: 0,
                unchanged: 0,
                needsUpdate: 0,
              },
            }),
          ])
        );
      })
  );

  it.effect("discovers a known Source Item total when progress opts in", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const sourceState: ObservableTotalDiscoverySourceState = {
        readAttempts: 0,
        readByIdentityAttempts: 0,
        totalDiscoveryAttempts: 0,
      };
      const events: MigrationProgressEvent[] = [];
      const definition = defineMigration({
        id: "articles",
        source: makeObservableTotalDiscoverySource({
          batchSize: 2,
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
            {
              identityKey: "article-2",
              version: "source-version-1",
              item: { title: "Article 2" },
            },
            {
              identityKey: "article-3",
              version: "source-version-1",
              item: { title: "Article 3" },
            },
          ],
          sourceItemTotal: Effect.succeed(SourceItemTotal.known(3)),
          state: sourceState,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
      });
      const progressLayer = Layer.succeed(MigrationProgress, {
        discoverSourceItemTotals: true,
        emit: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      const summary = yield* runMigration(definition).pipe(
        Effect.provide(progressLayer)
      );

      expect(summary.status).toBe("succeeded");
      expect(sourceState.totalDiscoveryAttempts).toBe(1);
      expect(sourceState.readByIdentityAttempts).toBe(0);
      expect(events.map((event) => event.kind)).toEqual([
        "run-started",
        "definition-started",
        "source-item-total-discovered",
        "source-item-completed",
        "source-item-completed",
        "source-cursor-window-completed",
        "source-item-completed",
        "source-cursor-window-completed",
        "definition-completed",
        "run-completed",
      ]);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            definitionId: definition.id,
            kind: "source-item-total-discovered",
            sourceItemTotal: SourceItemTotal.known(3),
          }),
        ])
      );
    })
  );

  it.effect(
    "emits an unsupported unknown Source Item total for sources without discovery",
    () =>
      Effect.gen(function* () {
        const events: MigrationProgressEvent[] = [];
        const sourceState: ObservableTotalDiscoverySourceState = {
          readAttempts: 0,
          readByIdentityAttempts: 0,
          totalDiscoveryAttempts: 0,
        };
        const definition = defineMigration({
          id: "articles",
          source: makeObservableTotalDiscoverySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article 1" },
              },
            ],
            state: sourceState,
          }),
          store: InMemoryMigrationStore.layer(),
          process: () => Effect.void,
        });
        const progressLayer = Layer.succeed(MigrationProgress, {
          discoverSourceItemTotals: true,
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        const summary = yield* runMigration(definition).pipe(
          Effect.provide(progressLayer)
        );

        expect(summary.status).toBe("succeeded");
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              definitionId: definition.id,
              kind: "source-item-total-discovered",
              sourceItemTotal: SourceItemTotal.unknown({
                message:
                  "Source plugin does not support Source Item total discovery",
                reason: "unsupported",
              }),
            }),
          ])
        );
      })
  );

  it.effect("does not discover Source Item totals for no-op progress", () =>
    Effect.gen(function* () {
      const sourceState: ObservableTotalDiscoverySourceState = {
        readAttempts: 0,
        readByIdentityAttempts: 0,
        totalDiscoveryAttempts: 0,
      };
      const definition = defineMigration({
        id: "articles",
        source: makeObservableTotalDiscoverySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Article 1" },
            },
          ],
          sourceItemTotal: Effect.succeed(SourceItemTotal.known(1)),
          state: sourceState,
        }),
        store: InMemoryMigrationStore.layer(),
        process: () => Effect.void,
      });

      const summary = yield* runMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(sourceState.totalDiscoveryAttempts).toBe(0);
      expect(sourceState.readAttempts).toBe(1);
    })
  );

  it.effect(
    "continues with an unknown failed Source Item total when discovery fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sourceState: ObservableTotalDiscoverySourceState = {
          readAttempts: 0,
          readByIdentityAttempts: 0,
          totalDiscoveryAttempts: 0,
        };
        const events: MigrationProgressEvent[] = [];
        const discoveryError = new SourcePluginError({
          message: "Count endpoint failed",
        });
        const definition = defineMigration({
          id: "articles",
          source: makeObservableTotalDiscoverySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article 1" },
              },
            ],
            sourceItemTotal: Effect.fail(discoveryError),
            state: sourceState,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
        });
        const progressLayer = Layer.succeed(MigrationProgress, {
          discoverSourceItemTotals: true,
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        const summary = yield* runMigration(definition).pipe(
          Effect.provide(progressLayer)
        );

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(sourceState.totalDiscoveryAttempts).toBe(1);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              definitionId: definition.id,
              kind: "source-item-total-discovered",
              sourceItemTotal: SourceItemTotal.unknown({
                cause: discoveryError,
                message: "Source Item total discovery failed",
                reason: "failed",
              }),
            }),
          ])
        );
      })
  );

  it.effect("advances Source Cursors after windows with item failures", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];
      const pipelineError: PipelineFailureTestError = {
        _tag: "PipelineFailureTestError",
        message: "Article cannot be transformed",
        code: "missing-title",
      };

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          batchSize: 2,
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: null },
            },
            {
              identityKey: "article-2",
              version: "source-version-1",
              item: { title: "Article 2" },
            },
            {
              identityKey: "article-3",
              version: "source-version-1",
              item: { title: "Article 3" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          source.identity.encoded === "article-1"
            ? Effect.fail(pipelineError)
            : Effect.sync(() => {
                processCalls.push(source.identity.encoded);
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
      expect(processCalls).toEqual(["article-2", "article-3"]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual(
        encodedInMemoryCursor(2)
      );
      expect(storeState.sourceCursorCommits).toEqual([
        {
          definitionId: definition.id,
          cursor: encodedInMemoryCursor(2),
        },
      ]);
    })
  );

  it.effect(
    "processes failed backlog before cursor discovery in normal mode",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-failed",
                version: "source-version-2",
                item: { title: "Recovered article" },
              },
              {
                identityKey: "article-new",
                version: "source-version-1",
                item: { title: "New article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(source.identity.encoded);
            }),
        });

        seedArticleMigrationContract(storeState);
        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "process",
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
        expect(processCalls).toEqual(["article-failed", "article-new"]);
      })
  );

  it.effect(
    "processes needs-update backlog before cursor discovery in normal mode",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];
        const previousStates: (typeof MigrationItemState.Type | undefined)[] =
          [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-needs-update",
                version: "source-version-1",
                item: { title: "Reserved article" },
              },
              {
                identityKey: "article-new",
                version: "source-version-1",
                item: { title: "New article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source, context) =>
            Effect.sync(() => {
              processCalls.push(source.identity.encoded);
              previousStates.push(context.previousState);
            }),
        });

        seedArticleMigrationContract(storeState);
        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-needs-update"
          ),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-needs-update"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "needs-update",
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
        expect(processCalls).toEqual(["article-needs-update", "article-new"]);
        expect(previousStates[0]).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Destination stub must be completed",
          })
        );
      })
  );

  it.effect("processes only failed Migration Item States in failed mode", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-failed",
              version: "source-version-1",
              item: { title: "Recovered article" },
            },
            {
              identityKey: "article-needs-update",
              version: "source-version-1",
              item: { title: "Reserved article" },
            },
            {
              identityKey: "article-new",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      seedArticleMigrationContract(storeState);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-failed"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "failed",
          error: {
            kind: "destination",
            errorTag: "DestinationPluginError",
            message: "destination effect failed",
          },
        }
      );
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-needs-update"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-needs-update"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "needs-update",
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
      expect(processCalls).toEqual(["article-failed"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect("reprocesses skipped Migration Item States in skipped mode", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-skipped",
              version: "source-version-1",
              item: { title: "Previously skipped article" },
            },
            {
              identityKey: "article-new",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      seedArticleMigrationContract(storeState);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-skipped"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-skipped"),
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
      expect(processCalls).toEqual(["article-skipped"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect("processes exactly one Source Identity in item mode", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-target",
              version: "source-version-1",
              item: { title: "Target article" },
            },
            {
              identityKey: "article-new",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      seedArticleMigrationContract(storeState);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-target"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-target"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
        }
      );

      const summary = yield* runMigrations({
        definitions: [definition],
        mode: { kind: "item", sourceIdentityKey: "article-target" },
      });

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(processCalls).toEqual(["article-target"]);
      expect(storeState.sourceCursorCommits).toEqual([]);
    })
  );

  it.effect(
    "reprocesses matching-version migrated Source Items during update runs",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sourceState = InMemorySourcePlugin.makeState();
        const processCalls: string[] = [];
        const previousStates: (typeof MigrationItemState.Type | undefined)[] =
          [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            batchSize: 1,
            state: sourceState,
            items: [
              {
                identityKey: "article-migrated",
                version: "source-version-1",
                item: { title: "Already migrated" },
              },
              {
                identityKey: "article-new",
                version: "source-version-1",
                item: { title: "New article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source, context) =>
            Effect.sync(() => {
              processCalls.push(source.identity.encoded);
              previousStates.push(context.previousState);
            }),
        });

        const previousRunId = toMigrationRunId("run-previous");
        const previousJournal = {
          process: {
            runId: previousRunId,
            entries: [
              {
                kind: "diagnostic" as const,
                sequence: 0,
                severity: "info" as const,
                message: "Created destination entry",
              },
            ],
          },
          rollbackAttempts: [],
        };
        const previousTrackingRecord = {
          entryId: "entry-previous",
          locale: "en-US",
        };

        seedArticleMigrationContract(storeState);
        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-migrated"),
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            lastRunId: previousRunId,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            journal: previousJournal,
            status: "migrated",
            trackingRecord: previousTrackingRecord,
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          update: true,
        });

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(processCalls).toEqual(["article-migrated", "article-new"]);
        expect(sourceState.readByIdentityAttempts).toBe(0);
        expect(storeState.sourceCursors.get(definition.id)).toEqual(
          encodedInMemoryCursor(1)
        );
        expect(previousStates[0]).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Scheduled by update run",
            sourceVersion: "source-version-1",
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            journal: previousJournal,
            trackingRecord: previousTrackingRecord,
          })
        );
        expect(previousStates[1]).toBeUndefined();
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            lastRunId: summary.runId,
            sourceVersion: "source-version-1",
          })
        );
      })
  );

  it.effect(
    "preserves prior tracking evidence when an update attempt fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "update-failed",
          message: "Update process failed",
        };
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const previousRunId = toMigrationRunId("run-previous");
        const previousJournal = {
          process: {
            runId: previousRunId,
            entries: [
              {
                kind: "diagnostic" as const,
                sequence: 0,
                severity: "info" as const,
                message: "Previous migration created destination evidence",
              },
            ],
          },
          rollbackAttempts: [],
        };
        const previousTrackingRecord = {
          entryId: "entry-previous",
          locale: "en-US",
        };
        let rollbackState: typeof MigrationItemState.Type | undefined;

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-migrated",
                version: "source-version-2",
                item: { title: "Previously migrated article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: () => Effect.fail(processError),
          rollback: (state) =>
            Effect.sync(() => {
              rollbackState = state;
            }),
        });

        seedTrackingMigrationContract(storeState, "articles", tracking);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-migrated"),
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            lastRunId: previousRunId,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            journal: previousJournal,
            status: "migrated",
            trackingRecord: previousTrackingRecord,
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          update: true,
        });
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
        );

        expect(summary.status).toBe("failed");
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "failed",
            journal: previousJournal,
            trackingRecord: previousTrackingRecord,
          })
        );

        const rollbackSummary = yield* rollbackMigration(definition);

        expect(rollbackSummary.status).toBe("succeeded");
        expect(rollbackState).toEqual(
          expect.objectContaining({
            status: "failed",
            journal: previousJournal,
            trackingRecord: previousTrackingRecord,
          })
        );
      })
  );

  it.effect(
    "preserves prior evidence when update attempts skip or fail tracking validation",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const previousRunId = toMigrationRunId("run-previous");
        const previousJournal = {
          process: {
            runId: previousRunId,
            entries: [
              {
                kind: "diagnostic" as const,
                sequence: 0,
                severity: "info" as const,
                message: "Previous destination evidence",
              },
            ],
          },
          rollbackAttempts: [],
        };
        const previousTrackingRecord = {
          entryId: "entry-previous",
          locale: "en-US",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-skip",
                version: "source-version-2",
                item: { title: "Skip update" },
              },
              {
                identityKey: "article-invalid-tracking",
                version: "source-version-2",
                item: { title: "Invalid tracking update" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: (source) =>
            source.identity.encoded === "article-skip"
              ? skipItem("No longer eligible")
              : Effect.void,
        });

        seedTrackingMigrationContract(storeState, "articles", tracking);

        for (const sourceIdentity of [
          "article-skip",
          "article-invalid-tracking",
        ]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey("articles", sourceIdentity),
            {
              definitionId: toMigrationDefinitionId("articles"),
              sourceIdentity: articleSourceIdentity(sourceIdentity),
              sourceVersion: toSourceVersion("source-version-1"),
              sourceVersionContractFingerprint:
                defaultSourceVersionContractFingerprint,
              lastRunId: previousRunId,
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              journal: previousJournal,
              status: "migrated",
              trackingRecord: previousTrackingRecord,
            }
          );
        }

        const summary = yield* runMigrations({
          definitions: [definition],
          update: true,
        });
        const skippedState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-skip")
        );
        const failedState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-invalid-tracking"
          )
        );

        expect(summary.status).toBe("failed");
        expect(skippedState).toEqual(
          expect.objectContaining({
            status: "skipped",
            journal: previousJournal,
            trackingRecord: previousTrackingRecord,
          })
        );
        expect(failedState).toEqual(
          expect.objectContaining({
            status: "failed",
            journal: previousJournal,
            trackingRecord: previousTrackingRecord,
            error: expect.objectContaining({
              kind: "tracking",
            }),
          })
        );
      })
  );

  it.effect(
    "lets a later retry read prior evidence and replace it on successful update",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const tracking = Tracking.record({
          id: "article-entry@v1",
          schema: ArticleTrackingRecord,
        });
        const processError: PipelineFailureTestError = {
          _tag: "PipelineFailureTestError",
          code: "update-failed",
          message: "Update failed before retry",
        };
        const previousRunId = toMigrationRunId("run-previous");
        const previousJournal = {
          process: {
            runId: previousRunId,
            entries: [
              {
                kind: "diagnostic" as const,
                sequence: 0,
                severity: "info" as const,
                message: "Previous destination evidence",
              },
            ],
          },
          rollbackAttempts: [],
        };
        const previousTrackingRecord = {
          entryId: "entry-previous",
          locale: "en-US",
        };
        const retryPreviousTrackingRecords: unknown[] = [];
        let failUpdate = true;

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-retry",
                version: "source-version-2",
                item: { title: "Retry update" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          tracking,
          process: (source, context) =>
            Effect.gen(function* () {
              if (failUpdate) {
                return yield* Effect.fail(processError);
              }

              const priorTrackingRecord =
                context.previousState !== undefined &&
                "trackingRecord" in context.previousState
                  ? context.previousState.trackingRecord
                  : undefined;

              retryPreviousTrackingRecords.push(priorTrackingRecord);

              yield* Tracking.logDiagnostic({
                severity: "info",
                message: `Retried ${source.item.title}`,
              });
              yield* Tracking.setRecord({
                entryId: "entry-fresh",
                locale: "en-US",
              });
            }),
        });

        seedTrackingMigrationContract(storeState, "articles", tracking);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-retry"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-retry"),
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            lastRunId: previousRunId,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            journal: previousJournal,
            status: "migrated",
            trackingRecord: previousTrackingRecord,
          }
        );

        const failedSummary = yield* runMigrations({
          definitions: [definition],
          update: true,
        });
        failUpdate = false;
        const retrySummary = yield* runMigration(definition);
        const itemState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-retry")
        );

        expect(failedSummary.status).toBe("failed");
        expect(retrySummary.status).toBe("succeeded");
        expect(retryPreviousTrackingRecords).toEqual([previousTrackingRecord]);
        expect(itemState).toEqual(
          expect.objectContaining({
            status: "migrated",
            trackingRecord: {
              entryId: "entry-fresh",
              locale: "en-US",
            },
          })
        );
        expect(
          itemState?.status === "migrated"
            ? itemState.journal?.process.runId
            : undefined
        ).toBe(retrySummary.runId);
      })
  );

  it.effect(
    "schedules migrated states for update and leaves other states unchanged",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];
        const previousRunId = toMigrationRunId("run-previous");
        const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
        const existingNeedsUpdateUpdatedAt = new Date(
          "2026-01-01T00:00:01.000Z"
        );
        const previousJournal = {
          process: {
            runId: previousRunId,
            entries: [
              {
                kind: "diagnostic" as const,
                sequence: 0,
                severity: "info" as const,
                message: "Created destination entry",
              },
            ],
          },
          rollbackAttempts: [],
        };
        const previousTrackingRecord = {
          entryId: "entry-previous",
          locale: "en-US",
        };

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [],
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(source.identity.encoded);
            }),
        });

        seedArticleMigrationContract(storeState);
        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(3));
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-migrated"),
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            lastRunId: previousRunId,
            updatedAt: previousUpdatedAt,
            journal: previousJournal,
            status: "migrated",
            trackingRecord: previousTrackingRecord,
          }
        );
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            "articles",
            "article-needs-update"
          ),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-needs-update"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: previousRunId,
            updatedAt: existingNeedsUpdateUpdatedAt,
            status: "needs-update",
            reason: "Already scheduled",
          }
        );
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: previousRunId,
            updatedAt: previousUpdatedAt,
            status: "failed",
            error: {
              kind: "process",
              errorTag: "PipelineFailureTestError",
              message: "Article could not be transformed",
            },
          }
        );
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-skipped"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-skipped"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: previousRunId,
            updatedAt: previousUpdatedAt,
            status: "skipped",
            skipReason: "No destination needed",
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          update: true,
        });

        expect(summary.status).toBe("succeeded");
        expect(processCalls).toEqual([]);
        expect(storeState.sourceCursors.get(definition.id)).toBeUndefined();
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Scheduled by update run",
            lastRunId: summary.runId,
            sourceVersion: "source-version-1",
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
            journal: previousJournal,
            trackingRecord: previousTrackingRecord,
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              "articles",
              "article-needs-update"
            )
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Already scheduled",
            lastRunId: previousRunId,
            updatedAt: existingNeedsUpdateUpdatedAt,
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-failed")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
            lastRunId: previousRunId,
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-skipped")
          )
        ).toEqual(
          expect.objectContaining({
            status: "skipped",
            lastRunId: previousRunId,
          })
        );
      })
  );

  it.effect(
    "leaves update-created needs-update backlog visible and resumes it without update intent",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sourceState = InMemorySourcePlugin.makeState();
        const sourceItems = [
          {
            identityKey: "article-seen",
            version: "source-version-2",
            item: { title: "Seen during update" },
          },
        ];
        const processCalls: string[] = [];

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            state: sourceState,
            items: sourceItems,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(source.identity.encoded);
            }),
        });

        seedArticleMigrationContract(storeState);
        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(2));

        for (const sourceIdentity of ["article-seen", "article-missing"]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey("articles", sourceIdentity),
            {
              definitionId: toMigrationDefinitionId("articles"),
              sourceIdentity: articleSourceIdentity(sourceIdentity),
              sourceVersion: toSourceVersion("source-version-1"),
              sourceVersionContractFingerprint:
                defaultSourceVersionContractFingerprint,
              lastRunId: toMigrationRunId("run-previous"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              status: "migrated",
            }
          );
        }

        const updateSummary = yield* runMigrations({
          definitions: [definition],
          update: true,
        });
        const durableAfterUpdate = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getItemStateSummary(definition.id);
        }).pipe(Effect.provide(InMemoryMigrationStore.layer(storeState)));

        expect(updateSummary.status).toBe("succeeded");
        expect(updateSummary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(processCalls).toEqual(["article-seen"]);
        expect(sourceState.readByIdentityAttempts).toBe(0);
        expect(durableAfterUpdate).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          needsUpdate: 1,
        });
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-missing")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Scheduled by update run",
          })
        );

        sourceItems.push({
          identityKey: "article-missing",
          version: "source-version-2",
          item: { title: "Recovered by normal run" },
        });
        processCalls.length = 0;

        const retrySummary = yield* runMigration(definition);
        const durableAfterRetry = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;

          return yield* store.getItemStateSummary(definition.id);
        }).pipe(Effect.provide(InMemoryMigrationStore.layer(storeState)));

        expect(retrySummary.status).toBe("succeeded");
        expect(retrySummary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 1,
          needsUpdate: 0,
        });
        expect(processCalls).toEqual(["article-missing"]);
        expect(sourceState.readByIdentityAttempts).toBe(1);
        expect(durableAfterRetry).toEqual({
          migrated: 2,
          skipped: 0,
          failed: 0,
          needsUpdate: 0,
        });
      })
  );

  it.effect(
    "keeps already scheduled update state when update preparation fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const updatePreparationError = new MigrationStoreError({
          message: "Unable to schedule migrated item for update",
        });
        const store = Layer.effect(
          MigrationStore,
          Effect.gen(function* () {
            const baseStore = yield* MigrationStore;

            return {
              ...baseStore,
              upsertItemState: (state: typeof MigrationItemState.Type) =>
                state.status === "needs-update" &&
                state.sourceIdentity.encoded === "article-second"
                  ? Effect.fail(updatePreparationError)
                  : baseStore.upsertItemState(state),
            };
          })
        ).pipe(Layer.provide(InMemoryMigrationStore.layer(storeState)));

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [],
          }),
          store,
          process: () => Effect.void,
        });

        seedArticleMigrationContract(storeState);
        storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(2));

        for (const sourceIdentity of ["article-first", "article-second"]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey("articles", sourceIdentity),
            {
              definitionId: toMigrationDefinitionId("articles"),
              sourceIdentity: articleSourceIdentity(sourceIdentity),
              sourceVersion: toSourceVersion("source-version-1"),
              sourceVersionContractFingerprint:
                defaultSourceVersionContractFingerprint,
              lastRunId: toMigrationRunId("run-previous"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              status: "migrated",
            }
          );
        }

        const error = yield* Effect.flip(
          runMigrations({
            definitions: [definition],
            update: true,
          })
        );

        expect(error).toEqual(updatePreparationError);
        expect(storeState.sourceCursors.get(definition.id)).toEqual(
          encodedInMemoryCursor(2)
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-first")
          )
        ).toEqual(
          expect.objectContaining({
            status: "needs-update",
            reason: "Scheduled by update run",
          })
        );
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-second")
          )
        ).toEqual(
          expect.objectContaining({
            status: "migrated",
            lastRunId: toMigrationRunId("run-previous"),
          })
        );
      })
  );

  it.effect("does not schedule update state when run preflight fails", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];
      const previousRunId = toMigrationRunId("run-previous");
      const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-migrated",
              version: "source-version-1",
              item: { title: "Already migrated" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-migrated"),
          sourceVersion: toSourceVersion("source-version-1"),
          sourceVersionContractFingerprint:
            defaultSourceVersionContractFingerprint,
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "migrated",
        }
      );

      const error = yield* Effect.flip(
        runMigrations({
          definitions: [definition],
          update: true,
        })
      );

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationRuntimeError",
          message: "Migration Definition source contract changed",
        })
      );
      expect(processCalls).toEqual([]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual(
        encodedInMemoryCursor(1)
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
        })
      );
    })
  );

  it.effect("does not schedule update state when lock acquisition fails", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];
      const previousRunId = toMigrationRunId("run-previous");
      const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");
      const lockError = new MigrationStoreError({
        message: "Migration definition lock unavailable",
      });
      const store = Layer.effect(
        MigrationStore,
        Effect.gen(function* () {
          const baseStore = yield* MigrationStore;

          return {
            ...baseStore,
            acquireDefinitionLock: () => Effect.fail(lockError),
          };
        })
      ).pipe(Layer.provide(InMemoryMigrationStore.layer(storeState)));

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-migrated",
              version: "source-version-1",
              item: { title: "Already migrated" },
            },
          ],
        }),
        store,
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      seedArticleMigrationContract(storeState);
      storeState.sourceCursors.set(definition.id, encodedInMemoryCursor(1));
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-migrated"),
          sourceVersion: toSourceVersion("source-version-1"),
          sourceVersionContractFingerprint:
            defaultSourceVersionContractFingerprint,
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "migrated",
        }
      );

      const error = yield* Effect.flip(
        runMigrations({
          definitions: [definition],
          update: true,
        })
      );

      expect(error).toEqual(lockError);
      expect(processCalls).toEqual([]);
      expect(storeState.sourceCursors.get(definition.id)).toEqual(
        encodedInMemoryCursor(1)
      );
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
        )
      ).toEqual(
        expect.objectContaining({
          status: "migrated",
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
        })
      );
    })
  );

  it.effect("rejects raw SDK update runs with targeted retry modes", () =>
    Effect.gen(function* () {
      const processCalls: string[] = [];
      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-target",
              version: "source-version-1",
              item: { title: "Target article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      const failedError = yield* Effect.flip(
        runMigrations({
          definitions: [definition],
          mode: { kind: "failed" },
          update: true,
        })
      );
      expect(failedError).toEqual(
        expect.objectContaining({
          _tag: "MigrationRuntimeError",
          message: "Update run cannot combine with failed mode",
        })
      );

      const skippedError = yield* Effect.flip(
        runMigrations({
          definitions: [definition],
          mode: { kind: "skipped" },
          update: true,
        })
      );
      expect(skippedError).toEqual(
        expect.objectContaining({
          _tag: "MigrationRuntimeError",
          message: "Update run cannot combine with skipped mode",
        })
      );

      const targetError = yield* Effect.flip(
        runMigrations({
          definitions: [definition],
          mode: { kind: "item", sourceIdentityKey: "article-target" },
          update: true,
        })
      );
      expect(targetError).toEqual(
        expect.objectContaining({
          _tag: "MigrationRuntimeError",
          message: "Update run cannot target source identities",
        })
      );
      expect(processCalls).toEqual([]);
    })
  );

  it.effect(
    "records Source identity lookup failures for known Migration Item States",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            identity: ArticleSourceIdentity,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "direct",
            read: () => Effect.succeed({ items: [] }),
            readByIdentity: () => Effect.fail(sourceError),
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
        });

        seedArticleMigrationContract(storeState);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "process",
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
    "records Source identity lookup failures for migrated item states",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            identity: ArticleSourceIdentity,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "direct",
            read: () => Effect.succeed({ items: [] }),
            readByIdentity: () => Effect.fail(sourceError),
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
        });

        seedArticleMigrationContract(storeState);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-migrated"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-migrated"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "migrated",
          }
        );

        const summary = yield* runMigrations({
          definitions: [definition],
          mode: { kind: "item", sourceIdentityKey: "article-migrated" },
        });

        expect(summary.status).toBe("failed");
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey("articles", "article-migrated")
          )
        ).toEqual(
          expect.objectContaining({
            status: "failed",
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
        const storeState = InMemoryMigrationStore.makeState();
        const processCalls: string[] = [];
        const sourceError = new SourcePluginError({
          message: "Source identity lookup failed",
          cause: new Error("Source system unavailable"),
        });

        const definition = defineMigration({
          id: "articles",
          source: defineSourcePlugin({
            cursorSchema: InMemorySourceCursor,
            identity: ArticleSourceIdentity,
            sourceSchema: Schema.Unknown,
            lookupStrategy: "direct",
            read: () =>
              Effect.succeed({
                items: [
                  {
                    identityKey: "article-failed",
                    version: toSourceVersion("source-version-2"),
                    item: { title: "Rediscovered article" },
                  },
                  {
                    identityKey: "article-new",
                    version: toSourceVersion("source-version-1"),
                    item: { title: "New article" },
                  },
                ],
              }),
            readByIdentity: () => Effect.fail(sourceError),
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(source.identity.encoded);
            }),
        });

        seedArticleMigrationContract(storeState);
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
          {
            definitionId: toMigrationDefinitionId("articles"),
            sourceIdentity: articleSourceIdentity("article-failed"),
            sourceVersion: toSourceVersion("source-version-1"),
            lastRunId: toMigrationRunId("run-previous"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            status: "failed",
            error: {
              kind: "process",
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
        expect(processCalls).toEqual(["article-new"]);
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

  it.effect("only counts previously migrated Source Items as unchanged", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Already migrated" },
            },
            {
              identityKey: "article-2",
              version: "source-version-1",
              item: { title: "Already skipped" },
            },
            {
              identityKey: "article-3",
              version: "source-version-1",
              item: { title: "New article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source) =>
          Effect.gen(function* () {
            pipelineCalls.push(source.identity.encoded);

            if (source.identity.encoded === "article-2") {
              return yield* skipItem("Still skipped");
            }
          }),
      });

      const previousRunId = toMigrationRunId("run-previous");
      const previousUpdatedAt = new Date("2026-01-01T00:00:00.000Z");

      seedArticleMigrationContract(storeState);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-1"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          sourceVersionContractFingerprint:
            defaultSourceVersionContractFingerprint,
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "migrated",
        }
      );
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-2"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-2"),
          sourceVersion: toSourceVersion("source-version-1"),
          sourceVersionContractFingerprint:
            defaultSourceVersionContractFingerprint,
          lastRunId: previousRunId,
          updatedAt: previousUpdatedAt,
          status: "skipped",
          skipReason: "No destination needed",
        }
      );

      const summary = yield* runMigration(definition);

      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 1,
        failed: 0,
        unchanged: 1,
        needsUpdate: 0,
      });
      expect(pipelineCalls).toEqual(["article-2", "article-3"]);
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
          skipReason: "Still skipped",
          lastRunId: summary.runId,
        })
      );
    })
  );

  it.effect("reprocesses Source Items when Source Version changes", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const pipelineCalls: string[] = [];
      const previousStates: (typeof MigrationItemState.Type | undefined)[] = [];

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-2",
              item: { title: "Updated article" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: (source, context) =>
          Effect.sync(() => {
            pipelineCalls.push(
              `${source.identity.encoded}:${context.previousState?.sourceVersion}`
            );
            previousStates.push(context.previousState);
          }),
      });

      seedArticleMigrationContract(storeState);
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey("articles", "article-1"),
        {
          definitionId: toMigrationDefinitionId("articles"),
          sourceIdentity: articleSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          lastRunId: toMigrationRunId("run-previous"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          status: "migrated",
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
      expect(previousStates).toHaveLength(1);
      expect(previousStates[0]).toEqual(
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
          lastRunId: summary.runId,
        })
      );
    })
  );

  it.effect(
    "expands selected Migration Definitions and executes dependencies first",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const executionOrder: string[] = [];

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              executionOrder.push(`authors:${source.identity.encoded}`);
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Dependent article" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              executionOrder.push(`articles:${source.identity.encoded}`);
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles"],
        });

        expect(summary.status).toBe("succeeded");
        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["authors", "articles"]);
        expect(executionOrder).toEqual([
          "authors:author-1",
          "articles:article-1",
        ]);
      })
  );

  it.effect(
    "summarizes selected dependencies once when also explicitly selected",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const executionOrder: string[] = [];

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              executionOrder.push(`authors:${source.identity.encoded}`);
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Dependent article" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              executionOrder.push(`articles:${source.identity.encoded}`);
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
          definitionIds: ["articles", "authors"],
        });

        expect(
          summary.definitions.map((definition) => definition.definitionId)
        ).toEqual(["authors", "articles"]);
        expect(summary.definitions).toHaveLength(2);
        expect(executionOrder).toEqual([
          "authors:author-1",
          "articles:article-1",
        ]);
      })
  );

  it.effect("uses the selected Migration Definition Store for run state", () =>
    Effect.gen(function* () {
      const unselectedStoreState = InMemoryMigrationStore.makeState();
      const selectedStoreState = InMemoryMigrationStore.makeState();

      const unselected = defineMigration({
        id: "unselected",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "unselected-1",
              version: "source-version-1",
              item: { title: "Unselected" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(unselectedStoreState),
        process: () => Effect.void,
      });
      const selected = defineMigration({
        id: "selected",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "selected-1",
              version: "source-version-1",
              item: { title: "Selected" },
            },
          ],
        }),
        store: InMemoryMigrationStore.layer(selectedStoreState),
        process: () => Effect.void,
      });

      const summary = yield* runMigrations({
        definitions: [unselected, selected],
        definitionIds: ["selected"],
      });

      expect(
        summary.definitions.map((definition) => definition.definitionId)
      ).toEqual(["selected"]);
      expect(unselectedStoreState.latestRunStates.size).toBe(0);
      expect(
        selectedStoreState.latestRunStates.get(
          toMigrationDefinitionId("selected")
        )
      ).toEqual(
        expect.objectContaining({
          status: "succeeded",
        })
      );
    })
  );

  it.effect(
    "rejects selected Migration Definitions that do not share a Migration Store",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const pipelineCalls: string[] = [];

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(authorsStoreState),
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Split store article" },
              },
            ],
          }),
          store: InMemoryMigrationStore.layer(articlesStoreState),
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({
            definitions: [articles, authors],
            definitionIds: ["articles"],
          })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message:
              "Migration Definitions in the same run must use the same Migration Store",
          })
        );
        expect(pipelineCalls).toEqual([]);
        expect(authorsStoreState.latestRunStates.size).toBe(0);
        expect(articlesStoreState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "rejects missing Migration Definition dependencies before execution",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Article with missing dependency" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles] })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition was not found",
          })
        );
        expect(pipelineCalls).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "rejects Migration Definition dependency cycles before execution",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        const authors = defineMigration({
          id: "authors",
          dependsOn: ["articles"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Cyclic article" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles, authors] })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationRuntimeError",
            message: "Migration Definition dependency cycle detected",
          })
        );
        expect(pipelineCalls).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "acquires and releases the full Migration Definition Lock set around the run",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const lockObservations: string[] = [];

        const observeLocks = (phase: "authors" | "articles") => {
          for (const definitionId of ["authors", "articles"] as const) {
            const lock = storeState.definitionLocks.get(
              toMigrationDefinitionId(definitionId)
            );

            lockObservations.push(
              `${phase}:${definitionId}:${lock?.ownerRunId ?? "none"}`
            );
          }
        };

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store,
          process: () =>
            Effect.sync(() => {
              observeLocks("authors");
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Locked article" },
              },
            ],
          }),
          store,
          process: () =>
            Effect.sync(() => {
              observeLocks("articles");
            }),
        });

        const summary = yield* runMigrations({
          definitions: [articles, authors],
        });

        expect(summary.status).toBe("succeeded");
        expect(lockObservations).toEqual([
          "authors:authors:run-1",
          "authors:articles:run-1",
          "articles:authors:run-1",
          "articles:articles:run-1",
        ]);
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect("preserves the primary error when failRun cleanup fails", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const sourceError = new SourcePluginError({
        message: "Source read failed",
      });
      const failRunError = new MigrationStoreError({
        message: "Unable to mark failed run",
      });

      const definition = defineMigration({
        id: "articles",
        source: defineSourcePlugin({
          cursorSchema: InMemorySourceCursor,
          identity: ArticleSourceIdentity,
          sourceSchema: Schema.Unknown,
          lookupStrategy: "scan",
          read: () => Effect.fail(sourceError),
          readByIdentity: () => Effect.succeed(null),
        }),
        store: failRunFailingStoreLayer(storeState, failRunError),
        process: () => Effect.void,
      });

      const error = yield* Effect.flip(runMigration(definition));
      const cause = error.cause as
        | {
            readonly failRunError?: unknown;
            readonly primaryError?: unknown;
          }
        | undefined;

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Unable to mark Migration Run failed",
        })
      );
      expect(cause?.primaryError).toBe(sourceError);
      expect(cause?.failRunError).toBe(failRunError);
      expect(storeState.definitionLocks.size).toBe(0);
    })
  );

  it.effect("surfaces Migration Definition Lock release failures", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const processCalls: string[] = [];
      const releaseError = new MigrationStoreError({
        message: "Unable to release Migration Definition Lock",
        cause: { definitionId: "articles" },
      });

      const definition = defineMigration({
        id: "articles",
        source: makeTestInMemorySource({
          items: [
            {
              identityKey: "article-1",
              version: "source-version-1",
              item: { title: "Release failure article" },
            },
          ],
        }),
        store: releaseFailingStoreLayer(storeState, releaseError),
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
      });

      const error = yield* Effect.flip(runMigration(definition));
      const cause = error.cause as
        | {
            readonly releaseFailures?: readonly {
              readonly definitionId: string;
              readonly error: unknown;
              readonly token: string;
            }[];
          }
        | undefined;

      expect(error).toEqual(
        expect.objectContaining({
          _tag: "MigrationStoreError",
          message: "Unable to release Migration Definition Lock set",
        })
      );
      expect(cause?.releaseFailures).toEqual([
        expect.objectContaining({
          definitionId: toMigrationDefinitionId("articles"),
          error: releaseError,
          token: "lock-1",
        }),
      ]);
      expect(processCalls).toEqual(["article-1"]);
      expect(storeState.definitionLocks.size).toBe(1);
      expect(
        storeState.latestRunStates.get(toMigrationDefinitionId("articles"))
      ).toEqual(
        expect.objectContaining({
          status: "succeeded",
        })
      );
    })
  );

  it.effect(
    "attempts every Migration Definition Lock release when cleanup fails",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const releaseError = new MigrationStoreError({
          message: "Unable to release Migration Definition Lock",
        });
        const processCalls: string[] = [];
        const releasedDefinitionIds: string[] = [];
        const store = releaseFailingStoreLayer(
          storeState,
          releaseError,
          (lock) => {
            releasedDefinitionIds.push(lock.definitionId);
          }
        );

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(`authors:${source.identity.encoded}`);
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Cleanup article" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              processCalls.push(`articles:${source.identity.encoded}`);
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles, authors] })
        );
        const cause = error.cause as
          | {
              readonly releaseFailures?: readonly {
                readonly definitionId: string;
                readonly error: unknown;
              }[];
            }
          | undefined;

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Unable to release Migration Definition Lock set",
          })
        );
        expect(processCalls).toEqual([
          "authors:author-1",
          "articles:article-1",
        ]);
        expect(releasedDefinitionIds).toEqual([
          toMigrationDefinitionId("authors"),
          toMigrationDefinitionId("articles"),
        ]);
        expect(cause?.releaseFailures).toEqual([
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("authors"),
            error: releaseError,
          }),
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            error: releaseError,
          }),
        ]);
        expect(storeState.definitionLocks.size).toBe(2);
      })
  );

  it.effect(
    "rejects concurrent Migration Definition Lock ownership before execution",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        storeState.definitionLocks.set(toMigrationDefinitionId("articles"), {
          definitionId: toMigrationDefinitionId("articles"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          ownerRunId: toMigrationRunId("run-other"),
          token: toMigrationDefinitionLockToken("lock-other"),
        });

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Locked article" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });

        const error = yield* Effect.flip(runMigration(definition));

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(pipelineCalls).toEqual([]);
        expect(
          storeState.definitionLocks.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            ownerRunId: "run-other",
            token: "lock-other",
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.migrationContracts.size).toBe(0);
      })
  );

  it.effect(
    "rejects overlapping lock sets before executing earlier definitions",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const pipelineCalls: string[] = [];

        storeState.definitionLocks.set(toMigrationDefinitionId("authors"), {
          definitionId: toMigrationDefinitionId("authors"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          ownerRunId: toMigrationRunId("run-other"),
          token: toMigrationDefinitionLockToken("lock-other"),
        });

        const authors = defineMigration({
          id: "authors",
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "author-1",
                version: "source-version-1",
                item: { name: "Ada" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });
        const articles = defineMigration({
          id: "articles",
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [
              {
                identityKey: "article-1",
                version: "source-version-1",
                item: { title: "Locked article" },
              },
            ],
          }),
          store,
          process: (source) =>
            Effect.sync(() => {
              pipelineCalls.push(source.identity.encoded);
            }),
        });

        const error = yield* Effect.flip(
          runMigrations({ definitions: [articles, authors] })
        );

        expect(error).toEqual(
          expect.objectContaining({
            _tag: "MigrationStoreError",
            message: "Migration definition is already locked",
          })
        );
        expect(pipelineCalls).toEqual([]);
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.migrationContracts.size).toBe(0);
        expect(storeState.definitionLocks).toEqual(
          new Map([
            [
              toMigrationDefinitionId("authors"),
              expect.objectContaining({
                ownerRunId: toMigrationRunId("run-other"),
                token: "lock-other",
              }),
            ],
          ])
        );
      })
  );
});

describe("rollbackMigration", () => {
  it.effect("runs a rollback process and deletes migrated item state", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const definitionId = toMigrationDefinitionId("articles");
      const sourceIdentity = toEncodedSourceIdentity("article-rollback");
      const migratedState = {
        definitionId,
        lastRunId: toMigrationRunId("run-previous"),
        sourceIdentity: SourceIdentity.fromEncoded(
          ArticleSourceIdentity,
          sourceIdentity
        ),
        sourceVersion: toSourceVersion("source-version-1"),
        status: "migrated" as const,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      let rollbackInput:
        | {
            readonly context: RollbackContext;
            readonly state: typeof MigrationItemState.Type;
          }
        | undefined;

      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity),
        migratedState
      );

      const definition = defineMigration({
        id: definitionId,
        source: makeTestInMemorySource({
          items: [],
          sourceSchema: ArticleSource,
        }),
        store,
        process: () => Effect.void,
        rollback: (state, context) => {
          rollbackInput = { context, state };
        },
      });

      const summary = yield* rollbackMigration(definition);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions[0]?.counts).toEqual({
        rolledBack: 1,
        failed: 0,
        skipped: 0,
      });
      expect(rollbackInput).toEqual({
        context: {
          definitionId,
          runId: summary.runId,
        },
        state: migratedState,
      });
      expect(
        storeState.itemStates.has(
          InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity)
        )
      ).toBe(false);
    })
  );

  it.effect("clears the Source Cursor when rollback finds no item state", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const definitionId = toMigrationDefinitionId("articles");
      const processCalls: string[] = [];

      storeState.sourceCursors.set(definitionId, encodedInMemoryCursor(1));

      const definition = defineMigration({
        id: definitionId,
        source: makeTestInMemorySource({
          batchSize: 1,
          items: [
            {
              identityKey: "article-rollback",
              version: "source-version-1",
              item: { title: "Rollback source cursor" },
            },
          ],
        }),
        store,
        process: (source) =>
          Effect.sync(() => {
            processCalls.push(source.identity.encoded);
          }),
        rollback: () => Effect.void,
      });

      const rollbackSummary = yield* rollbackMigration(definition, {
        sourceIdentityKeys: ["article-rollback"],
      });
      const runSummary = yield* runMigration(definition);

      expect(rollbackSummary.definitions[0]?.counts).toEqual({
        rolledBack: 0,
        failed: 0,
        skipped: 1,
      });
      expect(runSummary.definitions[0]?.counts).toEqual({
        migrated: 1,
        skipped: 0,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(processCalls).toEqual(["article-rollback"]);
    })
  );

  it.effect(
    "emits Rollback Progress events while rolling back item states",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const definitionId = toMigrationDefinitionId("articles");
        const sourceIdentity = toEncodedSourceIdentity("article-rollback");
        const events: RollbackProgressEvent[] = [];

        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity),
          {
            definitionId,
            lastRunId: toMigrationRunId("run-previous"),
            sourceIdentity: SourceIdentity.fromEncoded(
              ArticleSourceIdentity,
              sourceIdentity
            ),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated" as const,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          }
        );

        const definition = defineMigration({
          id: definitionId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => Effect.void,
        });
        const progressLayer = Layer.succeed(RollbackProgress, {
          emit: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        });

        const summary = yield* rollbackMigration(definition).pipe(
          Effect.provide(progressLayer)
        );

        expect(summary.definitions[0]?.counts).toEqual({
          rolledBack: 1,
          failed: 0,
          skipped: 0,
        });
        expect(events.map((event) => event.kind)).toEqual([
          "rollback-started",
          "definition-started",
          "source-item-completed",
          "definition-completed",
          "rollback-completed",
        ]);
        expect(events[0]).toEqual({
          definitionIds: [definitionId],
          kind: "rollback-started",
          runId: summary.runId,
        });
        expect(events[2]).toEqual({
          counts: {
            rolledBack: 1,
            failed: 0,
            skipped: 0,
          },
          definitionId,
          kind: "source-item-completed",
          outcome: "rolled-back",
          runId: summary.runId,
        });
      })
  );

  it.effect(
    "bounds concurrent Rollback Pipeline execution for item states",
    () =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const definitionId = toMigrationDefinitionId("articles");
        const state = {
          active: 0,
          maxActive: 0,
        };

        for (const sourceIdentity of [
          "article-rollback-1",
          "article-rollback-2",
          "article-rollback-3",
        ]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity),
            {
              definitionId,
              lastRunId: toMigrationRunId("run-previous"),
              sourceIdentity: SourceIdentity.fromEncoded(
                ArticleSourceIdentity,
                toEncodedSourceIdentity(sourceIdentity)
              ),
              sourceVersion: toSourceVersion("source-version-1"),
              status: "migrated" as const,
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }
          );
        }

        const definition = defineMigration({
          id: definitionId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () =>
            Effect.gen(function* () {
              state.active += 1;
              state.maxActive = Math.max(state.maxActive, state.active);
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Effect.sleep("1 second");
              state.active -= 1;
            }),
        });

        const fiber = yield* rollbackMigration(definition, {
          execution: { rollback: { concurrency: 2 } },
        }).pipe(Effect.forkChild);

        yield* Deferred.await(firstStarted);
        yield* TestClock.adjust("500 millis");

        expect(state.maxActive).toBe(2);

        yield* TestClock.adjust("3 seconds");
        const summary = yield* Fiber.join(fiber);

        expect(summary.definitions[0]?.counts).toEqual({
          rolledBack: 3,
          failed: 0,
          skipped: 0,
        });
      })
  );

  it.effect(
    "rejects invalid Rollback Pipeline concurrency before opening a run",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        let rollbackCalled = false;

        const definition = defineMigration({
          id: "articles",
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
          rollback: () =>
            Effect.sync(() => {
              rollbackCalled = true;
            }),
        });

        const error = yield* Effect.flip(
          rollbackMigration(definition, {
            execution: { rollback: { concurrency: 0 } },
          })
        );

        expect(error).toBeInstanceOf(RollbackRequestError);
        expect(error.message).toBe("Rollback request contains invalid input");
        expect(rollbackCalled).toBe(false);
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(storeState.itemStates.size).toBe(0);
      })
  );
});

describe("rollbackMigrations", () => {
  it.effect(
    "rolls back selected Migration Definitions in reverse dependency order",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const authorState = {
          definitionId: authorsId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: articleSourceIdentity("author-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        const articleState = {
          definitionId: articlesId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: articleSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };

        for (const itemState of [authorState, articleState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        }

        const authors = defineMigration({
          id: authorsId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = defineMigration({
          id: articlesId,
          dependsOn: [authorsId],
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });

        expectTypeOf(
          rollbackMigrations({ definitions: [articles, authors] })
        ).toEqualTypeOf<
          Effect.Effect<RollbackRunSummary, RollbackMigrationError>
        >();

        const summary = yield* rollbackMigrations({
          definitions: [articles, authors],
        });

        expect(summary.kind).toBe("rollback");
        expect(summary.status).toBe("succeeded");
        expect(summary.definitions).toEqual([
          {
            counts: {
              rolledBack: 1,
              failed: 0,
              skipped: 0,
            },
            definitionId: articlesId,
            status: "succeeded",
          },
          {
            counts: {
              rolledBack: 1,
              failed: 0,
              skipped: 0,
            },
            definitionId: authorsId,
            status: "succeeded",
          },
        ]);
        expect(storeState.latestRunStates.get(authorsId)).toEqual(
          expect.objectContaining({
            definitionIds: [authorsId, articlesId],
            runId: summary.runId,
            status: "succeeded",
          })
        );
      })
  );

  it.effect(
    "rolls back targeted source identities through multi-definition rollback requests",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const definitionId = toMigrationDefinitionId("articles");
        const targetedIdentity = toEncodedSourceIdentity("article-targeted");
        const untouchedIdentity = toEncodedSourceIdentity("article-untouched");
        const targetedState = {
          definitionId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: SourceIdentity.fromEncoded(
            ArticleSourceIdentity,
            targetedIdentity
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        const untouchedState = {
          definitionId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: SourceIdentity.fromEncoded(
            ArticleSourceIdentity,
            untouchedIdentity
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };

        for (const itemState of [targetedState, untouchedState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        }

        const definition = defineMigration({
          id: definitionId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
          rollback: () => undefined,
        });

        const summary = yield* rollbackMigrations({
          definitions: [definition],
          sourceIdentityKeys: [targetedIdentity],
        });

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions[0]?.counts).toEqual({
          rolledBack: 1,
          failed: 0,
          skipped: 0,
        });
        expect(
          storeState.itemStates.has(
            InMemoryMigrationStore.itemStateKey(definitionId, targetedIdentity)
          )
        ).toBe(false);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(definitionId, untouchedIdentity)
          )
        ).toEqual(untouchedState);
      })
  );

  it.effect(
    "fails preflight before creating a run when an unselected dependent has item state",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const acquiredDefinitionIds: string[] = [];
        const store = Layer.effect(
          MigrationStore,
          Effect.gen(function* () {
            const baseStore = yield* MigrationStore;

            return {
              ...baseStore,
              acquireDefinitionLock: (definitionId, runId) =>
                baseStore.acquireDefinitionLock(definitionId, runId).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      acquiredDefinitionIds.push(definitionId);
                    })
                  )
                ),
            };
          })
        ).pipe(Layer.provide(InMemoryMigrationStore.layer(storeState)));
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");

        for (const itemState of [
          {
            definitionId: authorsId,
            lastRunId: toMigrationRunId("run-previous"),
            sourceIdentity: articleSourceIdentity("author-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated" as const,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          {
            definitionId: articlesId,
            lastRunId: toMigrationRunId("run-previous"),
            sourceIdentity: articleSourceIdentity("article-1"),
            sourceVersion: toSourceVersion("source-version-1"),
            status: "migrated" as const,
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        }

        const authors = defineMigration({
          id: authorsId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = defineMigration({
          id: articlesId,
          dependsOn: [authorsId],
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });

        const error = yield* Effect.flip(
          rollbackMigrations({
            definitions: [authors, articles],
            definitionIds: ["authors"],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Rollback would leave dependent Migration Definition item state",
          })
        );
        expect(acquiredDefinitionIds).toEqual([authorsId]);
        expect(storeState.latestRunStates.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "fails preflight when an unselected dependent needed for safety uses a different Migration Store",
    () =>
      Effect.gen(function* () {
        const authorsStoreState = InMemoryMigrationStore.makeState();
        const articlesStoreState = InMemoryMigrationStore.makeState();
        const authorsStore = InMemoryMigrationStore.layer(authorsStoreState);
        const articlesStore = InMemoryMigrationStore.layer(articlesStoreState);
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const articleState = {
          definitionId: articlesId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: articleSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        articlesStoreState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            articleState.definitionId,
            articleState.sourceIdentity.encoded
          ),
          articleState
        );

        const authors = defineMigration({
          id: authorsId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store: authorsStore,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = defineMigration({
          id: articlesId,
          dependsOn: [authorsId],
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store: articlesStore,
          process: () => Effect.void,
          rollback: () => undefined,
        });

        const error = yield* Effect.flip(
          rollbackMigrations({
            definitions: [authors, articles],
            definitionIds: ["authors"],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message:
              "Rollback dependency preflight requires one Migration Store",
          })
        );
        expect(authorsStoreState.latestRunStates.size).toBe(0);
        expect(articlesStoreState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "fails preflight before creating a run when the dependent safety graph has a cycle",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const commentsId = toMigrationDefinitionId("comments");

        const authors = defineMigration({
          id: authorsId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const articles = defineMigration({
          id: articlesId,
          dependsOn: [authorsId, commentsId],
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const comments = defineMigration({
          id: commentsId,
          dependsOn: [articlesId],
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });

        const error = yield* Effect.flip(
          rollbackMigrations({
            definitions: [authors, articles, comments],
            definitionIds: ["authors"],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Migration Definition dependency cycle detected",
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect("rejects omitted forward-only dependents with item state", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const store = InMemoryMigrationStore.layer(storeState);
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const lockObservations: string[] = [];
      const authorState = {
        definitionId: authorsId,
        lastRunId: toMigrationRunId("run-previous"),
        sourceIdentity: articleSourceIdentity("author-1"),
        sourceVersion: toSourceVersion("source-version-1"),
        status: "migrated" as const,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      const articleSkippedState = {
        definitionId: articlesId,
        lastRunId: toMigrationRunId("run-previous"),
        skipReason: "Not migrated",
        sourceIdentity: articleSourceIdentity("article-skipped"),
        sourceVersion: toSourceVersion("source-version-1"),
        status: "skipped" as const,
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      };

      for (const itemState of [authorState, articleSkippedState]) {
        storeState.itemStates.set(
          InMemoryMigrationStore.itemStateKey(
            itemState.definitionId,
            itemState.sourceIdentity.encoded
          ),
          itemState
        );
      }

      const observeLocks = () => {
        for (const definitionId of [authorsId, articlesId]) {
          const lock = storeState.definitionLocks.get(definitionId);

          lockObservations.push(
            `${definitionId}:${lock?.ownerRunId ?? "none"}`
          );
        }
      };

      const authors = defineMigration({
        id: authorsId,
        source: makeTestInMemorySource({
          items: [],
          sourceSchema: ArticleSource,
        }),
        store,
        process: () => Effect.void,
        rollback: () => {
          observeLocks();
        },
      });
      const articles = defineMigration({
        id: articlesId,
        dependsOn: [authorsId],
        source: makeTestInMemorySource({
          items: [],
          sourceSchema: ArticleSource,
        }),
        store,
        process: () => Effect.void,
      });

      const error = yield* Effect.flip(
        rollbackMigrations({
          definitions: [authors, articles],
          definitionIds: ["authors"],
        })
      );

      expect(error).toBeInstanceOf(RollbackPreflightError);
      expect(error).toEqual(
        expect.objectContaining({
          message:
            "Rollback would leave dependent Migration Definition item state",
        })
      );
      expect(lockObservations).toEqual([]);
      expect(storeState.latestRunStates.size).toBe(0);
      expect(storeState.definitionLocks.size).toBe(0);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            authorsId,
            authorState.sourceIdentity.encoded
          )
        )
      ).toEqual(authorState);
      expect(
        storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey(
            articlesId,
            articleSkippedState.sourceIdentity.encoded
          )
        )
      ).toEqual(articleSkippedState);
    })
  );

  it.effect(
    "allows a selected forward-only Migration Definition with no item state as a no-op",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const definitionId = toMigrationDefinitionId("forward-only");
        const definition = defineMigration({
          id: definitionId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
        });

        const summary = yield* rollbackMigrations({
          definitions: [definition],
        });

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions).toEqual([
          {
            counts: {
              rolledBack: 0,
              failed: 0,
              skipped: 0,
            },
            definitionId,
            status: "succeeded",
          },
        ]);
        expect(storeState.latestRunStates.get(definitionId)).toEqual(
          expect.objectContaining({
            runId: summary.runId,
            status: "succeeded",
          })
        );
      })
  );

  it.effect("fails selected forward-only Migration Definition state", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const definitionId = toMigrationDefinitionId("forward-only");
      const sourceIdentity = toEncodedSourceIdentity("article-forward-only");
      storeState.itemStates.set(
        InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity),
        {
          definitionId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: SourceIdentity.fromEncoded(
            ArticleSourceIdentity,
            sourceIdentity
          ),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        }
      );
      const definition = defineMigration({
        id: definitionId,
        source: makeTestInMemorySource({
          items: [],
          sourceSchema: ArticleSource,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
      });

      const error = yield* Effect.flip(
        rollbackMigrations({
          definitions: [definition],
        })
      );

      expect(error).toBeInstanceOf(RollbackPreflightError);
      expect(error).toEqual(
        expect.objectContaining({
          message: "Migration Definition does not define a rollback process",
        })
      );
      expect(storeState.latestRunStates.size).toBe(0);
    })
  );

  it.effect("rejects invalid rollback requests before creating a run", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const definitionId = toMigrationDefinitionId("articles");
      const definition = defineMigration({
        id: definitionId,
        source: makeTestInMemorySource({
          items: [],
          sourceSchema: ArticleSource,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
        rollback: () => undefined,
      });

      const error = yield* Effect.flip(
        rollbackMigrations({
          definitions: [definition],
          definitionIds: [""],
        })
      );

      expect(error).toBeInstanceOf(RollbackRequestError);
      expect(error).toEqual(
        expect.objectContaining({
          message: "Rollback request contains invalid input",
        })
      );
      expect(storeState.latestRunStates.size).toBe(0);
    })
  );

  it.effect(
    "fails preflight before creating a run when selected dependencies are missing",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const articlesId = toMigrationDefinitionId("articles");
        const articles = defineMigration({
          id: articlesId,
          dependsOn: ["authors"],
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
          rollback: () => undefined,
        });

        const error = yield* Effect.flip(
          rollbackMigrations({
            definitions: [articles],
            definitionIds: ["articles"],
          })
        );

        expect(error).toBeInstanceOf(RollbackPreflightError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Migration Definition was not found",
          })
        );
        expect(storeState.latestRunStates.size).toBe(0);
      })
  );

  it.effect(
    "does not discover omitted dependents outside the supplied rollback graph",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const store = InMemoryMigrationStore.layer(storeState);
        const authorsId = toMigrationDefinitionId("authors");
        const articlesId = toMigrationDefinitionId("articles");
        const authorState = {
          definitionId: authorsId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: articleSourceIdentity("author-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        const omittedArticleState = {
          definitionId: articlesId,
          lastRunId: toMigrationRunId("run-previous"),
          sourceIdentity: articleSourceIdentity("article-1"),
          sourceVersion: toSourceVersion("source-version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        };

        for (const itemState of [authorState, omittedArticleState]) {
          storeState.itemStates.set(
            InMemoryMigrationStore.itemStateKey(
              itemState.definitionId,
              itemState.sourceIdentity.encoded
            ),
            itemState
          );
        }

        const authors = defineMigration({
          id: authorsId,
          source: makeTestInMemorySource({
            items: [],
            sourceSchema: ArticleSource,
          }),
          store,
          process: () => Effect.void,
          rollback: () => undefined,
        });

        const summary = yield* rollbackMigrations({
          definitions: [authors],
          definitionIds: ["authors"],
        });

        expect(summary.status).toBe("succeeded");
        expect(summary.definitions).toEqual([
          {
            counts: {
              rolledBack: 1,
              failed: 0,
              skipped: 0,
            },
            definitionId: authorsId,
            status: "succeeded",
          },
        ]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(
              articlesId,
              omittedArticleState.sourceIdentity.encoded
            )
          )
        ).toEqual(omittedArticleState);
      })
  );
});
