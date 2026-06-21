import { Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

const EntrySource = Schema.Struct({ title: Schema.String });
const EntrySourceIdentity = SourceIdentity.make({
  id: "entry@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const storeState = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(storeState);
const definitionId = toMigrationDefinitionId("articles");
const sourceIdentity = toEncodedSourceIdentity("articles-1");

storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey(definitionId, sourceIdentity),
  {
    definitionId,
    sourceIdentity: SourceIdentity.fromEncoded(
      EntrySourceIdentity,
      sourceIdentity
    ),
    sourceVersion: toSourceVersion("source-version-1"),
    lastRunId: toMigrationRunId("run-previous"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "migrated",
  }
);

const articles = MigrationDefinition.make({
  id: definitionId,
  source: InMemorySourcePlugin.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    items: [
      {
        identityKey: "articles-1",
        version: "source-version-1",
        item: { title: "articles" },
      },
    ],
  }),
  store,
  process: () => undefined,
  rollback: () => {
    throw new Error("rollback failed after progress");
  },
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
