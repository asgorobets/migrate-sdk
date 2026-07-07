import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionRegistryId,
  toMigrationRunId,
} from "migrate-sdk";
import {
  MigrationExecutionEnvelopeMissingRegistryIdError,
  makeMigrationRollbackExecutionEnvelope,
  makeMigrationRunExecutionEnvelope,
} from "migrate-sdk/core";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "execution-envelope-article@v1",
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
          executionDefinitionIds: [toMigrationDefinitionId("articles")],
          kind: "run",
          registryId: toMigrationDefinitionRegistryId("catalog"),
          request: { definitionIds: ["articles"] },
          runId: toMigrationRunId("run-envelope"),
          scopeDefinitionIds: [toMigrationDefinitionId("articles")],
        });
        expect(rollbackEnvelope).toEqual({
          executionDefinitionIds: [toMigrationDefinitionId("articles")],
          kind: "rollback",
          registryId: toMigrationDefinitionRegistryId("catalog"),
          request: { definitionIds: ["articles"] },
          runId: toMigrationRunId("rollback-envelope"),
          scopeDefinitionIds: [toMigrationDefinitionId("articles")],
        });
        expect(JSON.stringify(runEnvelope)).not.toContain("definitions");
        expect(JSON.stringify(rollbackEnvelope)).not.toContain("definitions");
      })
  );

  it.effect("requires a registry id before deriving an envelope", () =>
    Effect.gen(function* () {
      const articles = MigrationDefinition.make({
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
});
