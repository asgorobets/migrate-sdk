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
  id: "tui-large-rollback@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const store = InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState());

const definition = (id: string, dependency?: string) =>
  MigrationDefinition.make({
    dependencies: {
      optional: [],
      required:
        dependency === undefined ? [] : [toMigrationDefinitionId(dependency)],
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

const definitionIds = Array.from(
  { length: 18 },
  (_, index) => `migration-${String(index + 1).padStart(2, "0")}`
);
const rootDefinitionId = definitionIds[0];
const definitions = definitionIds.map((id, index) =>
  definition(id, index === 0 ? undefined : rootDefinitionId)
);

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions }),
});
