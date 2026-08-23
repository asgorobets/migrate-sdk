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

const Product = Schema.Struct({ title: Schema.String });
const ProductIdentity = SourceIdentity.make({
  id: "tui-source-status@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

const products = MigrationDefinition.make({
  id: toMigrationDefinitionId("products"),
  process: () => undefined,
  source: InMemorySource.make({
    identity: ProductIdentity,
    items: [
      {
        identityKey: "product-duplicate",
        item: { title: "First product" },
        version: "v1",
      },
      {
        identityKey: "product-duplicate",
        item: { title: "Second product" },
        version: "v2",
      },
      {
        identityKey: "product-unique",
        item: { title: "Unique product" },
        version: "v1",
      },
    ],
    sourceSchema: Product,
  }),
  store: InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState()),
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [products] }),
});
