import { Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const store = InMemoryMigrationStore.layer();

const articles = MigrationDefinition.make({
  id: toMigrationDefinitionId("articles"),
  source: InMemorySource.make({
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
