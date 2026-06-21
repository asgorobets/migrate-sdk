import { Schema } from "effect";
import {
  defaultSourceVersionContractFingerprint,
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

storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
  {
    definitionId,
    sourceIdentity: SourceIdentity.fromKey(
      EntrySourceIdentity,
      "article-failed"
    ),
    sourceVersion: toSourceVersion("source-version-1"),
    lastRunId: previousRunId,
    updatedAt: previousDate,
    status: "failed",
    error: {
      kind: "destination",
      errorTag: "DestinationError",
      message: "destination effect failed",
    },
  }
);
storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey("articles", "article-skipped"),
  {
    definitionId,
    sourceIdentity: SourceIdentity.fromKey(
      EntrySourceIdentity,
      "article-skipped"
    ),
    sourceVersion: toSourceVersion("source-version-1"),
    lastRunId: previousRunId,
    updatedAt: previousDate,
    status: "skipped",
    skipReason: "Draft article",
  }
);
storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey("articles", "article-target"),
  {
    definitionId,
    sourceIdentity: SourceIdentity.fromKey(
      EntrySourceIdentity,
      "article-target"
    ),
    sourceVersion: toSourceVersion("source-version-1"),
    lastRunId: previousRunId,
    updatedAt: previousDate,
    status: "migrated",
  }
);

const articles = MigrationDefinition.make({
  id: definitionId,
  source: InMemorySource.make({
    identity: EntrySourceIdentity,
    sourceSchema: EntrySource,
    items: [
      {
        identityKey: "article-failed",
        version: "source-version-1",
        item: { title: "Failed article" },
      },
      {
        identityKey: "article-skipped",
        version: "source-version-1",
        item: { title: "Skipped article" },
      },
      {
        identityKey: "article-target",
        version: "source-version-1",
        item: { title: "Target article" },
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
