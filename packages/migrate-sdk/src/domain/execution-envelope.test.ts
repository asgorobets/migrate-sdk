import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  DuplicateMigrationDefinitionRegistryId,
  defaultSourceVersionContractFingerprint,
  defineMigration,
  executeMigrationExecutionEnvelope,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryCatalog,
  MigrationDefinitionRegistryCatalogConstructionError,
  MigrationDefinitionRegistryCatalogLookupError,
  MigrationExecutionEnvelopeMissingRegistryIdError,
  MissingMigrationDefinitionRegistryId,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionRegistryId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "execution-envelope-article@v1",
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
          title: "Envelope article",
        },
      },
    ],
  });

describe("MigrationExecutionEnvelope", () => {
  it.effect(
    "derives serializable run and rollback envelopes from executable plans",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const articles = defineMigration({
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

        const runPlan = yield* registry.executable().planRun({
          definitionIds: ["articles"],
        });
        const rollbackPlan = yield* registry.executable().planRollback({
          definitionIds: ["articles"],
        });

        const runEnvelope = yield* makeMigrationRunExecutionEnvelope(runPlan, {
          runId: "run-envelope",
        });
        const rollbackEnvelope = yield* makeMigrationRollbackExecutionEnvelope(
          rollbackPlan,
          { runId: "rollback-envelope" }
        );

        expect(runEnvelope).toEqual({
          definitionIds: [toMigrationDefinitionId("articles")],
          kind: "run",
          plannedOrder: [toMigrationDefinitionId("articles")],
          registryId: toMigrationDefinitionRegistryId("catalog"),
          request: { definitionIds: ["articles"] },
          runId: toMigrationRunId("run-envelope"),
        });
        expect(rollbackEnvelope).toEqual({
          definitionIds: [toMigrationDefinitionId("articles")],
          kind: "rollback",
          plannedOrder: [toMigrationDefinitionId("articles")],
          registryId: toMigrationDefinitionRegistryId("catalog"),
          request: { definitionIds: ["articles"] },
          runId: toMigrationRunId("rollback-envelope"),
        });
        expect(JSON.stringify(runEnvelope)).not.toContain("definitions");
        expect(JSON.stringify(rollbackEnvelope)).not.toContain("definitions");
      })
  );

  it.effect("requires a registry id before deriving an envelope", () =>
    Effect.gen(function* () {
      const articles = defineMigration({
        id: "articles",
        source: makeArticlesSource(),
        store: InMemoryMigrationStore.layer(),
        process: () => Effect.void,
      });
      const registry = MigrationDefinitionRegistry.make({
        definitions: [articles] as const,
      });
      const plan = yield* registry.executable().planRun({
        definitionIds: ["articles"],
      });

      const error = yield* Effect.flip(
        makeMigrationRunExecutionEnvelope(plan, { runId: "run-envelope" })
      );

      expect(error).toEqual(
        new MigrationExecutionEnvelopeMissingRegistryIdError({
          kind: "run",
          message:
            "Migration Execution Envelope requires a registry-backed executable plan",
          runId: toMigrationRunId("run-envelope"),
        })
      );
    })
  );

  it.effect(
    "resolves registries from the catalog and rejects invalid catalogs",
    () =>
      Effect.gen(function* () {
        const articles = defineMigration({
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

        const resolved = yield* MigrationDefinitionRegistryCatalog.get(
          "catalog"
        ).pipe(
          Effect.provide(
            MigrationDefinitionRegistryCatalog.layer({ registries: [registry] })
          )
        );
        expect(resolved).toBe(registry);

        const duplicateError = yield* Effect.flip(
          MigrationDefinitionRegistryCatalog.get("catalog").pipe(
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
          MigrationDefinitionRegistryCatalog.get("catalog").pipe(
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
          MigrationDefinitionRegistryCatalog.get("missing").pipe(
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
            message:
              "Migration Definition Registry was not found in the catalog",
          })
        );
      })
  );

  it.effect(
    "executes run envelopes with the envelope run id after re-planning",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const articles = defineMigration({
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

        const summary = yield* executeMigrationExecutionEnvelope({
          ...envelope,
          plannedOrder: [],
        }).pipe(
          Effect.provide(
            MigrationDefinitionRegistryCatalog.layer({ registries: [registry] })
          )
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

  it.effect(
    "executes rollback envelopes with the envelope run id after re-planning",
    () =>
      Effect.gen(function* () {
        const storeState = InMemoryMigrationStore.makeState();
        const articles = defineMigration({
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

        yield* registry.run({ definitionIds: ["articles"] });
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
        const summary = yield* executeMigrationExecutionEnvelope(envelope).pipe(
          Effect.provide(
            MigrationDefinitionRegistryCatalog.layer({ registries: [registry] })
          )
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
