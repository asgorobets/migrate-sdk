import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import {
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationDefinitionRegistryCatalog,
  MigrationExecutable,
  type MigrationExecutableService,
  MigrationExecution,
  type MigrationRunSummary,
  type MigrationStore,
  type MigrationStoreError,
  type RollbackRunSummary,
  SourceIdentity,
  toMigrationRunId,
} from "migrate-sdk";

const ArticleSource = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "migration-execution-article@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const source = InMemorySourcePlugin.make({
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
});
