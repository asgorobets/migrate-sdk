import { Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
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
const probe = {
  executions: [],
  storeState,
};

globalThis.__migrateSdkCliExecutionProbe = probe;

const previousRunId = toMigrationRunId("run-previous");
const previousDate = new Date("2026-01-01T00:00:00.000Z");
const seedMigratedState = (id, identity) => {
  const definitionId = toMigrationDefinitionId(id);
  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey(definitionId, identity),
    {
      definitionId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, identity),
      sourceVersion: toSourceVersion("source-version-1"),
      lastRunId: previousRunId,
      updatedAt: previousDate,
      status: "migrated",
    }
  );
};

seedMigratedState("tags", "tags-1");
seedMigratedState("authors", "authors-1");
seedMigratedState("articles", "articles-1");

const definition = (id, identity, input = {}) =>
  MigrationDefinition.make({
    id: toMigrationDefinitionId(id),
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: [
        {
          identityKey: identity,
          version: "source-version-1",
          item: { title: id },
        },
      ],
    }),
    store,
    process: () => undefined,
    rollback: () => {
      probe.executions.push(`rollback:${id}`);
    },
    ...input,
  });

const authors = definition("authors", "authors-1");
const articles = definition("articles", "articles-1", {
  dependencies: {
    required: [toMigrationDefinitionId("authors")],
    optional: [toMigrationDefinitionId("tags")],
  },
});
const tags = definition("tags", "tags-1");

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [tags, articles, authors],
  }),
});
