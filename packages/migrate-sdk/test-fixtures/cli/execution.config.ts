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
const storeState = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(storeState);
const probe = {
  executions: [],
  storeState,
};

globalThis.__migrateSdkCliExecutionProbe = probe;

const definition = (id, title, input = {}) =>
  MigrationDefinition.make({
    id: toMigrationDefinitionId(id),
    source: InMemorySource.make({
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
