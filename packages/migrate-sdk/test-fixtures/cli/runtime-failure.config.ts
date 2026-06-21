import { Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySource,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const articles = MigrationDefinition.make({
  id: toMigrationDefinitionId("articles"),
  source: InMemorySource.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    batchSize: 0,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: { title: "Article" },
      },
    ],
  }),
  store: InMemoryMigrationStore.layer(),
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
