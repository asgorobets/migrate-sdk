import { Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const Content = Schema.Struct({ title: Schema.String });
const ContentIdentity = SourceIdentity.make({
  id: "tui-locked@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const state = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(state);
const definitionId = toMigrationDefinitionId("locked-migration");
const runId = toMigrationRunId("run-stuck");
const startedAt = new Date("2026-08-23T05:30:00.000Z");

state.definitionLocks.set(definitionId, {
  createdAt: startedAt,
  definitionId,
  ownerRunId: runId,
  token: toMigrationDefinitionLockToken("lock-stuck"),
});
state.latestRunStates.set(definitionId, {
  definitionIds: [definitionId],
  execution: {
    adapter: "test-detached",
    executionId: "stale-execution",
  },
  runId,
  startedAt,
  status: "running",
});
state.runStates.set(runId, {
  definitionIds: [definitionId],
  execution: {
    adapter: "test-detached",
    executionId: "stale-execution",
  },
  finishedAt: new Date("2026-08-23T05:31:00.000Z"),
  runId,
  startedAt,
  status: "succeeded",
});

const lockedMigration = MigrationDefinition.make({
  id: definitionId,
  process: () => undefined,
  rollback: () => undefined,
  source: InMemorySource.make({
    identity: ContentIdentity,
    items: [],
    sourceSchema: Content,
  }),
  store,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [lockedMigration],
  }),
});
