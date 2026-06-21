import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  MigrationStore,
  MigrationStoreError,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import {
  TestDurableMigrationExecutable,
  TestDurableMigrationExecutableAttachError,
  TestDurableMigrationExecutableStartRejectedError,
} from "migrate-sdk/testing";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "test-durable-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const makeArticlesSource = () =>
  InMemorySourcePlugin.make({
    identity: ArticleSourceIdentity,
    sourceSchema: ArticleSource,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: {
          title: "Test durable article",
        },
      },
    ],
  });

const makeFixture = (
  stateInput: Parameters<typeof TestDurableMigrationExecutable.makeState>[0] & {
    readonly releaseFails?: boolean;
  } = {}
) => {
  const { releaseFails, ...durableStateInput } = stateInput;
  const storeState = InMemoryMigrationStore.makeState();
  const articlesId = toMigrationDefinitionId("articles");
  const baseStore = InMemoryMigrationStore.layer(storeState);
  const store =
    releaseFails === true
      ? Layer.effect(
          MigrationStore,
          Effect.gen(function* () {
            const base = yield* MigrationStore;

            return {
              ...base,
              releaseDefinitionLock: () =>
                Effect.fail(
                  new MigrationStoreError({
                    message: "Release failed",
                  })
                ),
            };
          })
        ).pipe(Layer.provide(baseStore))
      : baseStore;
  const articles = MigrationDefinition.make({
    id: articlesId,
    source: makeArticlesSource(),
    store,
    process: () => Effect.void,
    rollback: () => undefined,
  });
  const registry = MigrationDefinitionRegistry.make({
    id: "catalog",
    definitions: [articles] as const,
  });
  const durableState =
    TestDurableMigrationExecutable.makeState(durableStateInput);

  return {
    articles,
    articlesId,
    durableState,
    registry,
    storeState,
  };
};

describe("TestDurableMigrationExecutable", () => {
  it.effect("starts executable run plans and returns a started result", () =>
    Effect.gen(function* () {
      const { articlesId, durableState, registry, storeState } = makeFixture();
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });

      const result = yield* MigrationExecutable.startRun(plan).pipe(
        Effect.provide(TestDurableMigrationExecutable.layer(durableState))
      );

      expect(result.kind).toBe("started");
      if (result.kind === "started") {
        expect(result.runId).toBe(toMigrationRunId("run-1"));
        expect(result.execution).toEqual({
          adapter: "test-durable",
          executionId: "test-execution-1",
        });
        expect(result.runId).not.toBe(result.execution.executionId);
        expect(durableState.envelopes.get(result.runId)).toEqual(
          expect.objectContaining({
            executionDefinitionIds: [articlesId],
            kind: "run",
            registryId: "catalog",
            runId: result.runId,
            scopeDefinitionIds: [articlesId],
          })
        );
        expect(durableState.executions.get(result.runId)).toEqual(
          result.execution
        );
        expect(durableState.locks.get(result.runId)).toEqual([
          expect.objectContaining({
            definitionId: articlesId,
            ownerRunId: result.runId,
          }),
        ]);
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            definitionId: articlesId,
            ownerRunId: result.runId,
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            execution: result.execution,
            runId: result.runId,
            status: "queued",
          })
        );
      }

      expect(durableState.queuedRunStates).toEqual([
        expect.objectContaining({
          runId: toMigrationRunId("run-1"),
          status: "queued",
        }),
      ]);
      expect(durableState.queuedRunStates[0]).not.toHaveProperty("execution");
    })
  );

  it.effect(
    "starts executable rollback plans and returns a started result",
    () =>
      Effect.gen(function* () {
        const { articlesId, durableState, registry, storeState } =
          makeFixture();
        const plan = yield* registry.executable().planRollback({
          definitionIds: ["articles"],
        });

        const result = yield* MigrationExecutable.startRollback(plan).pipe(
          Effect.provide(TestDurableMigrationExecutable.layer(durableState))
        );

        expect(result.kind).toBe("started");
        if (result.kind === "started") {
          expect(result.runId).toBe(toMigrationRunId("run-1"));
          expect(result.execution).toEqual({
            adapter: "test-durable",
            executionId: "test-execution-1",
          });
          expect(durableState.envelopes.get(result.runId)).toEqual(
            expect.objectContaining({
              executionDefinitionIds: [articlesId],
              kind: "rollback",
              locks: [
                expect.objectContaining({
                  definitionId: articlesId,
                  ownerRunId: result.runId,
                }),
              ],
              registryId: "catalog",
              runId: result.runId,
              scopeDefinitionIds: [articlesId],
            })
          );
          expect(storeState.latestRunStates.get(articlesId)).toEqual(
            expect.objectContaining({
              execution: result.execution,
              runId: result.runId,
              status: "queued",
            })
          );
        }
      })
  );

  it.effect(
    "marks queued run state start-failed when the provider rejects start",
    () =>
      Effect.gen(function* () {
        const { articlesId, durableState, registry, storeState } = makeFixture({
          rejectStart: true,
        });
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(TestDurableMigrationExecutable.layer(durableState))
          )
        );

        expect(error).toEqual(
          new TestDurableMigrationExecutableStartRejectedError({
            message: "Test durable provider rejected migration execution start",
            runId: toMigrationRunId("run-1"),
          })
        );
        expect(durableState.queuedRunStates).toEqual([
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "queued",
          }),
        ]);
        expect(durableState.envelopes.size).toBe(0);
        expect(durableState.executions.size).toBe(0);
        expect(durableState.locks.size).toBe(0);
        expect(storeState.definitionLocks.size).toBe(0);
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "start-failed",
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).not.toHaveProperty(
          "execution"
        );
      })
  );

  it.effect(
    "returns a typed store error when lock cleanup fails after provider start rejection",
    () =>
      Effect.gen(function* () {
        const { articlesId, durableState, registry, storeState } = makeFixture({
          rejectStart: true,
          releaseFails: true,
        });
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(TestDurableMigrationExecutable.layer(durableState))
          )
        );

        expect(error).toBeInstanceOf(MigrationStoreError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Unable to release Migration Definition Lock set",
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "start-failed",
          })
        );
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            ownerRunId: toMigrationRunId("run-1"),
          })
        );
      })
  );

  it.effect(
    "keeps workflow locks when attaching the accepted provider execution identity fails",
    () =>
      Effect.gen(function* () {
        const { articlesId, durableState, registry, storeState } = makeFixture({
          rejectAttach: true,
        });
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(TestDurableMigrationExecutable.layer(durableState))
          )
        );

        expect(error).toBeInstanceOf(TestDurableMigrationExecutableAttachError);
        expect(error).toEqual(
          expect.objectContaining({
            execution: {
              adapter: "test-durable",
              executionId: "test-execution-1",
            },
            message:
              "Test durable provider execution identity attachment failed",
            runId: toMigrationRunId("run-1"),
          })
        );
        expect(durableState.envelopes.get(toMigrationRunId("run-1"))).toEqual(
          expect.objectContaining({
            kind: "run",
            runId: toMigrationRunId("run-1"),
          })
        );
        expect(durableState.executions.size).toBe(0);
        expect(durableState.locks.size).toBe(0);
        expect(storeState.definitionLocks.get(articlesId)).toEqual(
          expect.objectContaining({
            ownerRunId: toMigrationRunId("run-1"),
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("run-1"),
            status: "queued",
          })
        );
        expect(storeState.latestRunStates.get(articlesId)).not.toHaveProperty(
          "execution"
        );
      })
  );

  it.effect(
    "rejects overlapping selected definitions while workflow locks are held",
    () =>
      Effect.gen(function* () {
        const { articlesId, durableState, registry, storeState } =
          makeFixture();
        const plan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });
        const started = yield* MigrationExecutable.startRun(plan).pipe(
          Effect.provide(TestDurableMigrationExecutable.layer(durableState))
        );
        expect(started.kind).toBe("started");

        const error = yield* Effect.flip(
          MigrationExecutable.startRun(plan).pipe(
            Effect.provide(TestDurableMigrationExecutable.layer(durableState))
          )
        );

        expect(error).toBeInstanceOf(MigrationStoreError);
        expect(error).toEqual(
          expect.objectContaining({
            message: "Migration definition is already locked",
          })
        );
        expect(durableState.queuedRunStates).toHaveLength(1);
        if (started.kind === "started") {
          expect(storeState.latestRunStates.get(articlesId)).toEqual(
            expect.objectContaining({
              execution: started.execution,
              runId: started.runId,
              status: "queued",
            })
          );
          expect(storeState.definitionLocks.get(articlesId)).toEqual(
            expect.objectContaining({
              ownerRunId: started.runId,
            })
          );
        }
      })
  );
});
