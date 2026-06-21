import { Schema } from "effect";
import {
  InMemoryMigrationStore,
  InMemorySource,
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
const definitionId = toMigrationDefinitionId("articles");
const storeState = InMemoryMigrationStore.makeState();
const runId = toMigrationRunId("run-status");
const updatedAt = new Date("2026-01-01T00:00:02.000Z");
const store = InMemoryMigrationStore.layer(storeState);

storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey(definitionId, "article-1"),
  {
    definitionId,
    lastRunId: runId,
    sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-1"),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "migrated",
    updatedAt,
  }
);
storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey(definitionId, "article-orphan"),
  {
    definitionId,
    lastRunId: runId,
    sourceIdentity: SourceIdentity.fromKey(
      EntrySourceIdentity,
      "article-orphan"
    ),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "migrated",
    updatedAt,
  }
);

const articles = MigrationDefinition.make({
  id: definitionId,
  source: InMemorySource.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    items: [
      {
        identityKey: "article-1",
        version: "source-version-1",
        item: { title: "Already migrated" },
      },
      {
        identityKey: "article-new",
        version: "source-version-1",
        item: { title: "New article" },
      },
      {
        identityKey: "article-new",
        version: "source-version-2",
        item: { title: "Duplicate article" },
      },
      {
        identityKey: "article-invalid",
        version: "source-version-1",
        item: {},
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
