import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  type ExecutionStartResult,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryCatalog,
  MigrationExecutable,
  type MigrationExecutableService,
  MigrationExecution,
  type MigrationRunHandle,
  type MigrationRunSummary,
  MigrationStore,
  type MigrationStoreError,
  type RollbackRunSummary,
  SourceIdentity,
  toMigrationRunId,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "migration-execution-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const source = InMemorySource.make({
  identity: ArticleSourceIdentity,
  sourceSchema: ArticleSource,
  items: [],
});
const store = {} as Layer.Layer<MigrationStore, MigrationStoreError>;

const articles = MigrationDefinition.make({
  id: "articles",
  source,
  store,
  process: () => Effect.void,
  rollback: () => Effect.succeed("rolled-back" as const),
});

const summaryDates = {
  finishedAt: new Date("2026-01-01T00:00:01.000Z"),
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const emptyCounts = {
  failed: 0,
  migrated: 0,
  needsUpdate: 0,
  skipped: 0,
  unchanged: 0,
};

const makeRunSummary = (): MigrationRunSummary => ({
  definitions: [
    {
      counts: emptyCounts,
      definitionId: articles.id,
      status: "succeeded",
    },
  ],
  runId: toMigrationRunId("run-service-test"),
  status: "succeeded",
  ...summaryDates,
});

const makeRollbackSummary = (): RollbackRunSummary => ({
  definitions: [
    {
      counts: {
        failed: 0,
        rolledBack: 0,
        skipped: 0,
      },
      definitionId: articles.id,
      status: "succeeded",
    },
  ],
  kind: "rollback",
  runId: toMigrationRunId("rollback-service-test"),
  status: "succeeded",
  ...summaryDates,
});

const attachedHandle = <Summary>(
  start: ExecutionStartResult<Summary>
): MigrationRunHandle<Summary> => {
  if (start.kind !== "started" || start.handle === undefined) {
    throw new Error("Expected attached inline execution");
  }

  return start.handle;
};

describe("MigrationExecution", () => {
  it.effect(
    "plans registry runs and delegates to the provided executable",
    () =>
      Effect.gen(function* () {
        const registry = MigrationDefinitionRegistry.make({
          definitions: [articles] as const,
          id: "service-registry",
        });
        const delegatedPlans: string[] = [];
        const executable: MigrationExecutableService = {
          startRollback: () => Effect.die("rollback should not be called"),
          startRun: (plan) =>
            Effect.sync(() => {
              delegatedPlans.push(plan.executionDefinitionIds.join(","));
              const summary = makeRunSummary();

              return {
                kind: "completed" as const,
                runId: summary.runId,
                summary,
              };
            }),
        };
        const layer = MigrationExecution.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              MigrationDefinitionRegistryCatalog.layer({
                registries: [registry],
              }),
              Layer.succeed(MigrationExecutable, executable)
            )
          )
        );

        const result = yield* MigrationExecution.run({
          definitionIds: ["articles"],
          registryId: "service-registry",
        }).pipe(Effect.provide(layer));

        expect(result.kind).toBe("completed");
        expect(delegatedPlans).toEqual(["articles"]);
      })
  );

  it.effect("constructs one-off registry execution explicitly with make", () =>
    Effect.gen(function* () {
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });
      const executable: MigrationExecutableService = {
        startRollback: () => {
          const summary = makeRollbackSummary();

          return Effect.succeed({
            kind: "completed" as const,
            runId: summary.runId,
            summary,
          });
        },
        startRun: () => {
          const summary = makeRunSummary();

          return Effect.succeed({
            kind: "completed" as const,
            runId: summary.runId,
            summary,
          });
        },
      };
      const execution = MigrationExecution.make({ executable, registry });

      const run = yield* execution.run({ all: true });
      const rollback = yield* execution.rollback({ all: true });

      expect(run.kind).toBe("completed");
      expect(rollback.kind).toBe("completed");
    })
  );

  it.effect(
    "drains started item work before cancellation becomes terminal",
    () =>
      Effect.gen(function* () {
        const itemStarted = yield* Deferred.make<void>();
        const releaseItem = yield* Deferred.make<void>();
        const effects: string[] = [];
        const storeState = InMemoryMigrationStore.makeState();
        const lifecycleStore = InMemoryMigrationStore.layer(storeState);
        const definition = MigrationDefinition.make({
          id: "cancellable-articles",
          source: InMemorySource.make({
            batchSize: 2,
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
          }),
          store: lifecycleStore,
          process: (source) =>
            Effect.gen(function* () {
              effects.push(`${source.item.title}:first`);

              if (source.item.title === "First article") {
                yield* Deferred.succeed(itemStarted, undefined);
                yield* Deferred.await(releaseItem);
              }

              effects.push(`${source.item.title}:second`);
            }),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [definition] as const,
        });
        const execution = MigrationExecution.make({ registry });
        const start = yield* execution.run({
          all: true,
          execution: { process: { concurrency: 1 } },
        });
        const handle = attachedHandle(start);

        yield* Deferred.await(itemStarted);

        const cancelling = yield* handle.cancel;

        expect(cancelling.status).toBe("cancelling");
        expect((yield* handle.get).status).toBe("cancelling");
        expect(storeState.definitionLocks.size).toBe(1);
        expect(effects).toEqual(["First article:first"]);

        yield* Deferred.succeed(releaseItem, undefined);

        const terminal = yield* handle.wait;

        expect(terminal.kind).toBe("cancelled");
        expect(terminal.state.status).toBe("cancelled");
        expect(effects).toEqual([
          "First article:first",
          "First article:second",
        ]);
        expect(
          storeState.itemStates.get(
            InMemoryMigrationStore.itemStateKey(definition.id, "article-1")
          )?.status
        ).toBe("migrated");
        expect(
          storeState.itemStates.has(
            InMemoryMigrationStore.itemStateKey(definition.id, "article-2")
          )
        ).toBe(false);
        expect(storeState.sourceCursorCommits).toEqual([]);
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect(
    "observes a durable cancellation request without an in-process handle call",
    () =>
      Effect.gen(function* () {
        const itemStarted = yield* Deferred.make<void>();
        const releaseItem = yield* Deferred.make<void>();
        const processed: string[] = [];
        const storeState = InMemoryMigrationStore.makeState();
        const durableStore = InMemoryMigrationStore.layer(storeState);
        const definition = MigrationDefinition.make({
          id: "durably-cancellable-articles",
          source: InMemorySource.make({
            batchSize: 2,
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
          }),
          store: durableStore,
          process: (source) =>
            Effect.gen(function* () {
              processed.push(source.item.title);

              if (source.item.title === "First article") {
                yield* Deferred.succeed(itemStarted, undefined);
                yield* Deferred.await(releaseItem);
              }
            }),
        });
        const execution = MigrationExecution.make({
          registry: MigrationDefinitionRegistry.make({
            definitions: [definition] as const,
          }),
        });
        const start = yield* execution.run({
          all: true,
          execution: { process: { concurrency: 1 } },
        });
        const handle = attachedHandle(start);

        yield* Deferred.await(itemStarted);
        const requested = yield* MigrationStore.pipe(
          Effect.flatMap((store) =>
            store.requestRunCancellation(handle.runId, [definition.id])
          ),
          Effect.provide(durableStore)
        );

        expect(requested.status).toBe("cancelling");
        expect(storeState.definitionLocks.size).toBe(1);

        yield* TestClock.adjust("1 second");
        yield* Deferred.succeed(releaseItem, undefined);
        const terminal = yield* handle.wait;

        expect(terminal.kind).toBe("cancelled");
        expect(processed).toEqual(["First article"]);
        expect(storeState.definitionLocks.size).toBe(0);
      })
  );

  it.effect("keeps the Store scope alive until supervised work completes", () =>
    Effect.gen(function* () {
      const itemStarted = yield* Deferred.make<void>();
      const releaseItem = yield* Deferred.make<void>();
      const storeState = InMemoryMigrationStore.makeState();
      const baseStore = InMemoryMigrationStore.layer(storeState);
      let finalizedStores = 0;
      const scopedStore = Layer.effect(
        MigrationStore,
        Effect.gen(function* () {
          const service = yield* MigrationStore;

          yield* Effect.acquireRelease(Effect.void, () =>
            Effect.sync(() => {
              finalizedStores += 1;
            })
          );

          return service;
        })
      ).pipe(Layer.provide(baseStore));
      const definition = MigrationDefinition.make({
        id: "scoped-store-articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
              item: { title: "Scoped Store article" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
        }),
        store: scopedStore,
        process: () =>
          Deferred.succeed(itemStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseItem))
          ),
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [definition] as const,
      });
      const execution = MigrationExecution.make({ registry });
      const start = yield* execution.run({ all: true });
      const handle = attachedHandle(start);

      yield* Deferred.await(itemStarted);
      expect(finalizedStores).toBe(0);

      yield* Deferred.succeed(releaseItem, undefined);
      expect((yield* handle.wait).kind).toBe("finished");
      expect(finalizedStores).toBe(1);
    })
  );

  it.effect("persists cancellation before releasing definition locks", () =>
    Effect.gen(function* () {
      const itemStarted = yield* Deferred.make<void>();
      const releaseItem = yield* Deferred.make<void>();
      const lifecycle: string[] = [];
      const storeState = InMemoryMigrationStore.makeState();
      const baseStore = InMemoryMigrationStore.layer(storeState);
      const observedStore = Layer.effect(
        MigrationStore,
        Effect.gen(function* () {
          const service = yield* MigrationStore;

          return {
            ...service,
            markRunCancelled: (runId, definitionIds) =>
              Effect.sync(() => {
                lifecycle.push("cancelled");
              }).pipe(
                Effect.andThen(service.markRunCancelled(runId, definitionIds))
              ),
            releaseDefinitionLock: (lock) =>
              Effect.sync(() => {
                lifecycle.push("released");
              }).pipe(Effect.andThen(service.releaseDefinitionLock(lock))),
          };
        })
      ).pipe(Layer.provide(baseStore));
      const definition = MigrationDefinition.make({
        id: "cancellation-order-articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
              item: { title: "Cancellation order" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
        }),
        store: observedStore,
        process: () =>
          Deferred.succeed(itemStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseItem))
          ),
      });
      const execution = MigrationExecution.make({
        registry: MigrationDefinitionRegistry.make({
          definitions: [definition] as const,
        }),
      });
      const start = yield* execution.run({ all: true });
      const handle = attachedHandle(start);

      yield* Deferred.await(itemStarted);
      yield* handle.cancel;
      yield* Deferred.succeed(releaseItem, undefined);
      yield* handle.wait;

      expect(lifecycle).toEqual(["cancelled", "released"]);
    })
  );

  it.effect("reports failed inline execution and releases its lock", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const definition = MigrationDefinition.make({
        id: "failing-articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
              item: { title: "Failing article" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.die("process failed"),
      });
      const execution = MigrationExecution.make({
        registry: MigrationDefinitionRegistry.make({
          definitions: [definition] as const,
        }),
      });

      const handle = attachedHandle(yield* execution.run({ all: true }));

      expect((yield* handle.wait).kind).toBe("execution-failed");
      expect(storeState.latestRunStates.get(definition.id)?.status).toBe(
        "failed"
      );
      expect(storeState.definitionLocks.size).toBe(0);
    })
  );

  it.effect("drains an active rollback item before cancellation", () =>
    Effect.gen(function* () {
      const rollbackStarted = yield* Deferred.make<void>();
      const releaseRollback = yield* Deferred.make<void>();
      const storeState = InMemoryMigrationStore.makeState();
      const definition = MigrationDefinition.make({
        id: "rollback-cancellation-articles",
        source: InMemorySource.make({
          identity: ArticleSourceIdentity,
          items: [
            {
              identityKey: "article-1",
              item: { title: "Rollback article" },
              version: "source-version-1",
            },
          ],
          sourceSchema: ArticleSource,
        }),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
        rollback: () =>
          Deferred.succeed(rollbackStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRollback)),
            Effect.as("rolled-back" as const)
          ),
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [definition] as const,
      });
      const execution = MigrationExecution.make({ registry });
      const migration = yield* execution.run({ all: true });
      expect((yield* attachedHandle(migration).wait).kind).toBe("finished");

      const rollback = yield* execution.rollback({ all: true });
      const rollbackHandle = attachedHandle(rollback);

      yield* Deferred.await(rollbackStarted);
      expect((yield* rollbackHandle.cancel).status).toBe("cancelling");
      expect(storeState.definitionLocks.size).toBe(1);

      yield* Deferred.succeed(releaseRollback, undefined);

      const terminal = yield* rollbackHandle.wait;
      expect(terminal.kind).toBe("cancelled");
      expect(terminal.state.definitionIds).toEqual([definition.id]);
      expect(storeState.itemStates.size).toBe(0);
      expect(storeState.definitionLocks.size).toBe(0);
    })
  );

  it.effect(
    "observes an attached run without reading persisted run state",
    () =>
      Effect.gen(function* () {
        const itemStarted = yield* Deferred.make<void>();
        const releaseItem = yield* Deferred.make<void>();
        const storeState = InMemoryMigrationStore.makeState();
        const baseStore = InMemoryMigrationStore.layer(storeState);
        let persistedRunReads = 0;
        const observedStore = Layer.effect(
          MigrationStore,
          Effect.gen(function* () {
            const service = yield* MigrationStore;

            return {
              ...service,
              getLatestRunState: (definitionId) =>
                Effect.sync(() => {
                  persistedRunReads += 1;
                }).pipe(
                  Effect.andThen(service.getLatestRunState(definitionId))
                ),
            };
          })
        ).pipe(Layer.provide(baseStore));
        const definition = MigrationDefinition.make({
          id: "locally-observed-articles",
          source: InMemorySource.make({
            identity: ArticleSourceIdentity,
            items: [
              {
                identityKey: "article-1",
                item: { title: "Locally observed article" },
                version: "source-version-1",
              },
            ],
            sourceSchema: ArticleSource,
          }),
          store: observedStore,
          process: () =>
            Deferred.succeed(itemStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseItem))
            ),
        });
        const registry = MigrationDefinitionRegistry.make({
          definitions: [definition] as const,
        });
        const execution = MigrationExecution.make({ registry });
        const start = yield* execution.run({ all: true });
        const handle = attachedHandle(start);

        yield* Deferred.await(itemStarted);
        const readsBeforeObservation = persistedRunReads;

        expect((yield* handle.get).status).toBe("running");
        const waiter = yield* handle.wait.pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(persistedRunReads).toBe(readsBeforeObservation);

        yield* handle.cancel;
        yield* Deferred.succeed(releaseItem, undefined);
        expect((yield* Fiber.join(waiter)).kind).toBe("cancelled");
      })
  );
});
