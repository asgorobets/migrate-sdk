import { Effect, Layer, Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySource,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  SourceIdentity,
  toMigrationRunId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const articles = MigrationDefinition.make({
  id: "articles",
  source: InMemorySource.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    items: [],
  }),
  store: InMemoryMigrationStore.layer(),
  process: () => undefined,
  rollback: () => undefined,
});

const executableLayer = Layer.succeed(MigrationExecutable, {
  startRun: (plan) =>
    Effect.succeed({
      execution: {
        adapter: "test-cli-executable",
        executionId: `run:${plan.executionDefinitionIds.join(",")}`,
      },
      kind: "started" as const,
      runId: toMigrationRunId("run-configured-executable"),
    }),
  startRollback: (plan) =>
    Effect.succeed({
      execution: {
        adapter: "test-cli-executable",
        executionId: `rollback:${plan.executionDefinitionIds.join(",")}`,
      },
      kind: "started" as const,
      runId: toMigrationRunId("rollback-configured-executable"),
    }),
});

export default defineMigrationCliConfig({
  executableLayer,
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
