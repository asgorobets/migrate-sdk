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

state.definitionLocks.set(definitionId, {
  createdAt: new Date("2026-08-23T05:30:00.000Z"),
  definitionId,
  ownerRunId: toMigrationRunId("run-stuck"),
  token: toMigrationDefinitionLockToken("lock-stuck"),
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
