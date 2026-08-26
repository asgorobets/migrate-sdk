import { Effect, Schema } from "effect";
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
const store = InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState());

const definition = (id: "authors" | "books" | "locked") => {
  const identity = SourceIdentity.make({
    id: `tui-concurrent-${id}@v1`,
    schema: SourceIdentity.key("id", Schema.NonEmptyString),
  });

  return MigrationDefinition.make({
    id: toMigrationDefinitionId(id),
    process: () => Effect.sleep("3 seconds"),
    source: InMemorySource.make({
      identity,
      items: [
        {
          identityKey: `${id}-item`,
          item: { title: `${id} migration item` },
          version: "v1",
        },
      ],
      sourceSchema: Content,
    }),
    store,
  });
};

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [
      definition("authors"),
      definition("books"),
      definition("locked"),
    ],
  }),
});
