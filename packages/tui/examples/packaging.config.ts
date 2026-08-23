import { Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const Content = Schema.Struct({ title: Schema.String });
const ContentIdentity = SourceIdentity.make({
  id: "packaging-fixture@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const definition = MigrationDefinition.make({
  id: toMigrationDefinitionId("packaging-fixture"),
  process: () => undefined,
  source: InMemorySource.make({
    identity: ContentIdentity,
    items: [
      { identityKey: "fixture-1", item: { title: "Fixture" }, version: "v1" },
    ],
    sourceSchema: Content,
  }),
  store: InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState()),
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [definition] }),
});
