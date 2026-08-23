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
  id: "tui-transitive-dependency@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const store = InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState());

const definition = (id: string, dependencies: readonly string[] = []) =>
  MigrationDefinition.make({
    dependencies: {
      optional: [],
      required: dependencies.map(toMigrationDefinitionId),
    },
    id: toMigrationDefinitionId(id),
    process: () => undefined,
    rollback: () => undefined,
    source: InMemorySource.make({
      identity: ContentIdentity,
      items: [
        {
          identityKey: `${id}-1`,
          item: { title: id },
          version: "v1",
        },
      ],
      sourceSchema: Content,
    }),
    store,
  });

const authors = definition("authors");
const articles = definition("articles", ["authors"]);
const pages = definition("pages", ["articles"]);

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [authors, articles, pages],
  }),
});
