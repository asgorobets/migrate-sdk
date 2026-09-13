import { Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

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

storeState.definitionCompletions.set(definitionId, {
  definitionId,
  runId,
  completedAt: updatedAt,
  sourceCursor: null,
});
storeState.latestRunStates.set(definitionId, {
  definitionIds: [definitionId],
  finishedAt: new Date("2026-01-01T00:00:01.000Z"),
  runId,
  startedAt: new Date("2026-01-01T00:00:00.000Z"),
  status: "succeeded",
  operation: "run",
});
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
  InMemoryMigrationStore.itemStateKey(definitionId, "article-2"),
  {
    definitionId,
    lastRunId: runId,
    skipReason: "Draft article",
    sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-2"),
    sourceVersion: toSourceVersion("source-version-1"),
    status: "skipped",
    updatedAt,
  }
);

const articles = MigrationDefinition.make({
  id: definitionId,
  source: InMemorySource.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    items: [],
  }),
  store,
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
