import { Effect, Layer, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import {
  acquireScopedExecutable,
  releaseScopedExecutable,
} from "./scoped-executable-support.ts";

const Content = Schema.Struct({ title: Schema.String });
const ContentIdentity = SourceIdentity.make({
  id: "scoped-executable-fixture@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const definition = MigrationDefinition.make({
  id: toMigrationDefinitionId("scoped-executable-fixture"),
  process: () => Effect.void,
  source: InMemorySource.make({
    identity: ContentIdentity,
    items: [
      { identityKey: "fixture-1", item: { title: "Fixture" }, version: "v1" },
    ],
    sourceSchema: Content,
  }),
  store: InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState()),
});
const executableLayer = Layer.effect(
  MigrationExecutable,
  Effect.acquireRelease(acquireScopedExecutable, () => releaseScopedExecutable)
);

export default defineMigrationCliConfig({
  executableLayer,
  registry: MigrationDefinitionRegistry.make({ definitions: [definition] }),
});
