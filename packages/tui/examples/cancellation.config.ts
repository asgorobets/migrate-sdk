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
const ContentIdentity = SourceIdentity.make({
  id: "tui-cancellation@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const cancellable = MigrationDefinition.make({
  id: toMigrationDefinitionId("cancellable"),
  process: () => Effect.sleep("3 seconds"),
  source: InMemorySource.make({
    identity: ContentIdentity,
    items: [
      {
        identityKey: "slow-item",
        item: { title: "Slow migration item" },
        version: "v1",
      },
    ],
    sourceSchema: Content,
  }),
  store: InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState()),
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [cancellable] }),
});
