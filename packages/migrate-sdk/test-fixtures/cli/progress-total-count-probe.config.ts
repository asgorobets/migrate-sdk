import { Effect, Schema } from "effect";
import {
  defineMigration,
  defineSourcePlugin,
  InMemoryMigrationStore,
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
const store = InMemoryMigrationStore.layer();
const probe = {
  totalCountAttempts: 0,
};

globalThis.__migrateSdkCliTotalCountProbe = probe;

const source = defineSourcePlugin({
  cursorSchema: Schema.Null,
  countTotal: () =>
    Effect.sync(() => {
      probe.totalCountAttempts += 1;
      return 1;
    }),
  identity: EntrySourceIdentity,
  lookupStrategy: "scan",
  read: () =>
    Effect.succeed({
      items: [
        {
          identityKey: "article-1",
          version: "source-version-1",
          item: { title: "Article 1" },
        },
      ],
    }),
  readByIdentity: () => Effect.succeed(null),
  sourceSchema: EntrySource,
});

const articles = defineMigration({
  id: toMigrationDefinitionId("articles"),
  source,
  store,
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
