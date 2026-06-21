import { Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySourcePlugin,
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
const store = InMemoryMigrationStore.layer();

const articles = MigrationDefinition.make({
  id: toMigrationDefinitionId("articles"),
  source: InMemorySourcePlugin.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    batchSize: 2,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: { title: "Article 1" },
      },
      {
        identityKey: "article-2",
        version: "source-version-1",
        item: { title: "Article 2" },
      },
      {
        identityKey: "article-3",
        version: "source-version-1",
        item: { title: "Article 3" },
      },
    ],
  }),
  store,
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
