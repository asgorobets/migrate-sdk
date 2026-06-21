import { Schema } from "effect";
import {
  defaultSourceVersionContractFingerprint,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toEncodedSourceCursor,
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
const store = InMemoryMigrationStore.layer(storeState);
const probe = {
  executions: [],
  storeState,
};

globalThis.__migrateSdkCliExecutionProbe = probe;

const previousRunId = toMigrationRunId("run-previous");
const previousDate = new Date("2026-01-01T00:00:00.000Z");

storeState.migrationContracts.set(definitionId, {
  definitionId,
  sourceIdentityContractFingerprint: EntrySourceIdentity.fingerprint,
  sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint,
});
storeState.sourceCursors.set(
  definitionId,
  toEncodedSourceCursor('{"offset":1}')
);
storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey(definitionId, "article-migrated"),
  {
    definitionId,
    sourceIdentity: SourceIdentity.fromKey(
      EntrySourceIdentity,
      "article-migrated"
    ),
    sourceVersion: toSourceVersion("source-version-1"),
    sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint,
    lastRunId: previousRunId,
    updatedAt: previousDate,
    status: "migrated",
  }
);

const articles = MigrationDefinition.make({
  id: definitionId,
  source: InMemorySourcePlugin.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    batchSize: 1,
    items: [
      {
        identityKey: "article-migrated",
        version: "source-version-1",
        item: { title: "Already migrated" },
      },
      {
        identityKey: "article-new",
        version: "source-version-1",
        item: { title: "New article" },
      },
    ],
  }),
  store,
  process: (sourceItem) => {
    probe.executions.push(sourceItem.identity.encoded);
  },
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
