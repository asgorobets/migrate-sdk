import { Effect, Schema } from "effect";
import {
  InMemoryMigrationStore,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  SourcePlugin,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const store = InMemoryMigrationStore.layer();
const source = SourcePlugin.make({
  cursorSchema: Schema.Null,
  identity: EntrySourceIdentity,
  lookupStrategy: "scan",
  read: () =>
    Effect.succeed({
      items: [
        {
          identityKey: "article-1",
          version: "source-version-1",
          item: { title: "Article 1" },
        },
      ],
    }),
  readByIdentity: () => Effect.succeed(null),
  sourceSchema: EntrySource,
});

const articles = MigrationDefinition.make({
  id: toMigrationDefinitionId("articles"),
  source,
  store,
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
