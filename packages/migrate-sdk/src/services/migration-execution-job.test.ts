import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  DuplicateMigrationDefinitionRegistryId,
  defaultSourceVersionContractFingerprint,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryCatalogConstructionError,
  MigrationDefinitionRegistryCatalogLookupError,
  MigrationExecution,
  MigrationStore,
  MissingMigrationDefinitionRegistryId,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionRegistryId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import {
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
  MigrationDefinitionRegistryCatalog,
  MigrationExecutionJob,
  MigrationRollbackExecutor,
  MigrationRunExecutor,
} from "migrate-sdk/core";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "execution-job-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const makeArticlesSource = () =>
  InMemorySource.make({
    identity: ArticleSourceIdentity,
    sourceSchema: ArticleSource,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: {
          title: "Job article",
        },
      },
    ],
  });

const provideExecutionJobRuntime = (
  registry: ReturnType<typeof MigrationDefinitionRegistry.make>
) =>
  Layer.mergeAll(
    MigrationDefinitionRegistryCatalog.layer({
      registries: [registry],
    }),
    MigrationRunExecutor.layer,
    MigrationRollbackExecutor.layer
  );

describe("MigrationExecutionJob", () => {
  it.effect("surfaces catalog errors while resolving envelopes", () =>
    Effect.gen(function* () {
      const articles = MigrationDefinition.make({
        id: "articles",
        source: makeArticlesSource(),
        store: InMemoryMigrationStore.layer(),
        process: () => Effect.void,
      });
      const registry = MigrationDefinitionRegistry.make({
        id: "catalog",
        definitions: [articles] as const,
      });
      const duplicateRegistry = MigrationDefinitionRegistry.make({
        id: "catalog",
        definitions: [articles] as const,
      });
      const missingIdRegistry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });
      const envelope = yield* makeMigrationRunExecutionEnvelope(plan, {
        runId: "run-envelope",
      });

      const duplicateError = yield* Effect.flip(
        MigrationExecutionJob.fromEnvelope(envelope).pipe(
          Effect.provide(
            MigrationDefinitionRegistryCatalog.layer({
              registries: [registry, duplicateRegistry],
            })
          )
        )
      );
      expect(duplicateError).toEqual(
        new MigrationDefinitionRegistryCatalogConstructionError({
          message:
            "Migration Definition Registry Catalog contains invalid registries",
          issues: [
            new DuplicateMigrationDefinitionRegistryId({
              registryId: toMigrationDefinitionRegistryId("catalog"),
            }),
          ],
        })
      );

      const missingIdError = yield* Effect.flip(
        MigrationExecutionJob.fromEnvelope(envelope).pipe(
          Effect.provide(
            MigrationDefinitionRegistryCatalog.layer({
              registries: [missingIdRegistry],
            })
          )
        )
      );
      expect(missingIdError).toEqual(
        new MigrationDefinitionRegistryCatalogConstructionError({
          message:
            "Migration Definition Registry Catalog contains invalid registries",
          issues: [
            new MissingMigrationDefinitionRegistryId({
              message:
                "Migration Definition Registry Catalog requires registry ids",
            }),
          ],
        })
      );

      const lookupError = yield* Effect.flip(
        MigrationExecutionJob.fromEnvelope({
          ...envelope,
          registryId: toMigrationDefinitionRegistryId("missing"),
        }).pipe(
          Effect.provide(
            MigrationDefinitionRegistryCatalog.layer({
              registries: [registry],
            })
          )
        )
      );
      expect(lookupError).toEqual(
        new MigrationDefinitionRegistryCatalogLookupError({
          registryId: toMigrationDefinitionRegistryId("missing"),
          message: "Migration Definition Registry was not found in the catalog",
        })
      );
    })
  );

  it.effect("executes run jobs with the envelope run id after re-planning", () =>
    Effect.gen(function* () {
      const storeState = InMemoryMigrationStore.makeState();
      const articles = MigrationDefinition.make({
        id: "articles",
        source: makeArticlesSource(),
        store: InMemoryMigrationStore.layer(storeState),
        process: () => Effect.void,
      });
      const registry = MigrationDefinitionRegistry.make({
        id: "catalog",
        definitions: [articles] as const,
      });
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });
      const envelope = yield* makeMigrationRunExecutionEnvelope(plan, {
        runId: "run-envelope",
      });

      const job = yield* MigrationExecutionJob.fromEnvelope({
        ...envelope,
        executionDefinitionIds: [],
      }).pipe(Effect.provide(provideExecutionJobRuntime(registry)));
      expect(job.kind).toBe("run");
      expect(job.options.runId).toBe(toMigrationRunId("run-envelope"));
      expect(job.plan.executionDefinitionIds).toEqual([
        toMigrationDefinitionId("articles"),
      ]);

      const summary = yield* MigrationExecutionJob.execute(job).pipe(
        Effect.provide(provideExecutionJobRuntime(registry))
      );

      expect(summary.runId).toBe(toMigrationRunId("run-envelope"));
      expect(
        storeState.latestRunStates.get(toMigrationDefinitionId("articles"))
      ).toEqual(
        expect.objectContaining({
          runId: toMigrationRunId("run-envelope"),
          status: "succeeded",
        })
      );
    })
  );

  it.effect("executes run jobs with workflow-owned locks", () =>
    Effect.gen(function* () {
      const definitionId = toMigrationDefinitionId("articles");
      const runId = toMigrationRunId("leased-run-envelope");
      const lockOwnersDuringProcess: string[] = [];
      const storeState = InMemoryMigrationStore.makeState();
      const storeLayer = InMemoryMigrationStore.layer(storeState);
      const articles = MigrationDefinition.make({
        id: definitionId,
        source: makeArticlesSource(),
        store: storeLayer,
        process: () =>
          Effect.sync(() => {
            lockOwnersDuringProcess.push(
              storeState.definitionLocks.get(definitionId)?.ownerRunId ?? "none"
            );
          }),
      });
      const registry = MigrationDefinitionRegistry.make({
        id: "catalog",
        definitions: [articles] as const,
      });
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });
      const lock = yield* Effect.gen(function* () {
        const store = yield* MigrationStore;

        return yield* store.acquireDefinitionLock(definitionId, runId);
      }).pipe(Effect.provide(storeLayer));
      const envelope = yield* makeMigrationRunExecutionEnvelope(plan, {
        locks: [lock],
        runId,
      });

      const job = yield* MigrationExecutionJob.fromEnvelope(envelope).pipe(
        Effect.provide(provideExecutionJobRuntime(registry))
      );
      expect(job.options.lease?.runId).toBe(runId);

      const summary = yield* MigrationExecutionJob.execute(job).pipe(
        Effect.provide(provideExecutionJobRuntime(registry))
      );

      expect(summary.runId).toBe(runId);
      expect(lockOwnersDuringProcess).toEqual([runId]);
      expect(storeState.definitionLocks.size).toBe(0);
    })
  );

  it.effect(
    "executes rollback jobs with the envelope run id after re-planning",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const articles = MigrationDefinition.make({
          id: "articles",
          source: makeArticlesSource(),
          store: InMemoryMigrationStore.layer(storeState),
          process: () => Effect.void,
          rollback: () => undefined,
        });
        const registry = MigrationDefinitionRegistry.make({
          id: "catalog",
          definitions: [articles] as const,
        });

        const run = yield* MigrationExecution.make({ registry }).run({
          definitionIds: ["articles"],
        });
        expect(run.kind).toBe("completed");
        const migratedState = storeState.itemStates.get(
          InMemoryMigrationStore.itemStateKey("articles", "article-1")
        );
        expect(migratedState).toEqual(
          expect.objectContaining({
            lastRunId: expect.not.stringMatching("rollback-envelope"),
            sourceVersion: toSourceVersion("source-version-1"),
            sourceVersionContractFingerprint:
              defaultSourceVersionContractFingerprint,
          })
        );

        const plan = yield* registry.executable().planRollback({
          definitionIds: ["articles"],
        });
        const envelope = yield* makeMigrationRollbackExecutionEnvelope(plan, {
          runId: "rollback-envelope",
        });
        const job = yield* MigrationExecutionJob.fromEnvelope(envelope).pipe(
          Effect.provide(provideExecutionJobRuntime(registry))
        );
        expect(job.kind).toBe("rollback");
        expect(job.options.runId).toBe(toMigrationRunId("rollback-envelope"));

        const summary = yield* MigrationExecutionJob.execute(job).pipe(
          Effect.provide(provideExecutionJobRuntime(registry))
        );

        expect(summary.runId).toBe(toMigrationRunId("rollback-envelope"));
        expect(
          storeState.latestRunStates.get(toMigrationDefinitionId("articles"))
        ).toEqual(
          expect.objectContaining({
            runId: toMigrationRunId("rollback-envelope"),
            status: "succeeded",
          })
        );
      })
  );
});
