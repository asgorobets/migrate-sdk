import { Effect, Layer, Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationStore,
  MigrationStoreError,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const baseStore = InMemoryMigrationStore.layer(
  InMemoryMigrationStore.makeState()
);
const store = Layer.effect(
  MigrationStore,
  Effect.gen(function* () {
    const migrationStore = yield* MigrationStore;

    return {
      ...migrationStore,
      completeRun: () =>
        Effect.fail(
          new MigrationStoreError({
            message: "completeRun failed after progress",
          })
        ),
    };
  })
).pipe(Layer.provide(baseStore));

const articles = MigrationDefinition.make({
  id: toMigrationDefinitionId("articles"),
  source: InMemorySourcePlugin.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    batchSize: 1,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: { title: "Article 1" },
      },
    ],
  }),
  store,
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
