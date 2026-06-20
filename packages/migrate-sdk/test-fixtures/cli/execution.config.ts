import { Schema } from "effect";
import {
  defineMigration,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
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
const storeState = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(storeState);
const probe = {
  executions: [],
  storeState,
};

globalThis.__migrateSdkCliExecutionProbe = probe;

const definition = (id, title, input = {}) =>
  defineMigration({
    id: toMigrationDefinitionId(id),
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: [
        {
          identityKey: `${id}-1`,
          version: "source-version-1",
          item: { title },
        },
      ],
    }),
    store,
    process: () => {
      probe.executions.push(id);
    },
    ...input,
  });

const authors = definition("authors", "Author");
const articles = definition("articles", "Article", {
  dependencies: {
    required: [toMigrationDefinitionId("authors")],
    optional: [toMigrationDefinitionId("tags")],
  },
});
const tags = definition("tags", "Tag");

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [tags, articles, authors],
  }),
});
