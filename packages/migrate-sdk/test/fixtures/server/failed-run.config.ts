import { Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const definitionId = toMigrationDefinitionId("failed-run");
const runId = toMigrationRunId("failed-run-1");
const startedAt = new Date("2026-08-26T12:00:00.000Z");
const state = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(state);
const identity = SourceIdentity.make({
  id: "failed-run@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const definition = MigrationDefinition.make({
  id: definitionId,
  process: () => undefined,
  source: InMemorySource.make({
    identity,
    items: [],
    sourceSchema: Schema.Struct({ value: Schema.String }),
  }),
  store,
});

state.runStates.set(runId, {
  definitionIds: [definitionId],
  finishedAt: new Date("2026-08-26T12:00:01.000Z"),
  runId,
  startedAt,
  status: "failed",
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [definition] }),
});
