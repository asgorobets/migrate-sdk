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
  id: "tui-limited-run@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
export const makeLimitedRunConfig = () => {
  const store = InMemoryMigrationStore.layer(
    InMemoryMigrationStore.makeState()
  );

  const definition = (id: string, dependencies: readonly string[] = []) =>
    MigrationDefinition.make({
      dependencies: {
        optional: [],
        required: dependencies.map(toMigrationDefinitionId),
      },
      group: "content",
      id: toMigrationDefinitionId(id),
      process: () => undefined,
      rollback: () => undefined,
      source: InMemorySource.make({
        identity: ContentIdentity,
        items: Array.from({ length: 4 }, (_, index) => ({
          identityKey: `${id}-${index + 1}`,
          item: { title: `${id} ${index + 1}` },
          version: "v1",
        })),
        sourceSchema: Content,
      }),
      store,
    });

  const authors = definition("authors");
  const articles = definition("articles", ["authors"]);

  return defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [authors, articles],
    }),
  });
};

export default makeLimitedRunConfig();
