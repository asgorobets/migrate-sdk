import { Schema } from "effect";
import {
  defaultSourceVersionContractFingerprint,
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

const Content = Schema.Struct({ title: Schema.String });
const ContentIdentity = SourceIdentity.make({
  id: "content@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const state = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(state);
const previousRunId = toMigrationRunId("run-demo-previous");
const startedAt = new Date("2026-08-22T13:00:00.000Z");
const finishedAt = new Date("2026-08-22T13:00:02.000Z");

const item = (identityKey: string, title: string) => ({
  identityKey,
  item: { title },
  version: "v1",
});

const definition = (
  id: string,
  items: readonly ReturnType<typeof item>[],
  input: Record<string, unknown> = {}
) =>
  MigrationDefinition.make({
    group: "content",
    id: toMigrationDefinitionId(id),
    process: () => undefined,
    rollback: () => undefined,
    source: InMemorySource.make({
      identity: ContentIdentity,
      items,
      sourceSchema: Content,
    }),
    store,
    ...input,
  });

const authors = definition("authors", [
  item("author-ada", "Ada Lovelace"),
  item("author-grace", "Grace Hopper"),
]);
const articles = definition(
  "articles",
  [item("article-welcome", "Welcome"), item("article-effect", "Effect")],
  {
    dependencies: {
      optional: [toMigrationDefinitionId("assets")],
      required: [toMigrationDefinitionId("authors")],
    },
  }
);
const assets = definition("assets", [item("asset-logo", "Logo")], {
  rollback: undefined,
});

for (const definitionId of ["authors", "articles", "assets"]) {
  state.migrationContracts.set(toMigrationDefinitionId(definitionId), {
    definitionId: toMigrationDefinitionId(definitionId),
    sourceIdentityContractFingerprint: ContentIdentity.fingerprint,
    sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint,
  });
}

const seedRun = (id: string, status: "failed" | "succeeded") => {
  const definitionId = toMigrationDefinitionId(id);
  state.latestRunStates.set(definitionId, {
    definitionIds: [definitionId],
    finishedAt,
    runId: previousRunId,
    startedAt,
    status,
  });
};

seedRun("authors", "succeeded");
seedRun("articles", "failed");
seedRun("assets", "succeeded");

state.itemStates.set(
  InMemoryMigrationStore.itemStateKey("authors", "author-ada"),
  {
    definitionId: toMigrationDefinitionId("authors"),
    lastRunId: previousRunId,
    sourceIdentity: SourceIdentity.fromKey(ContentIdentity, "author-ada"),
    sourceVersion: toSourceVersion("v1"),
    status: "migrated",
    updatedAt: finishedAt,
  }
);
state.itemStates.set(
  InMemoryMigrationStore.itemStateKey("articles", "article-welcome"),
  {
    definitionId: toMigrationDefinitionId("articles"),
    journal: {
      process: {
        entries: [
          {
            details: { locale: "en-US", slug: "welcome" },
            kind: "diagnostic",
            message: "Published article route",
            sequence: 0,
            severity: "info",
          },
        ],
        runId: previousRunId,
      },
      rollbackAttempts: [],
    },
    lastRunId: previousRunId,
    sourceIdentity: SourceIdentity.fromKey(ContentIdentity, "article-welcome"),
    sourceVersion: toSourceVersion("v1"),
    status: "migrated",
    updatedAt: finishedAt,
  }
);
state.itemStates.set(
  InMemoryMigrationStore.itemStateKey("articles", "article-effect"),
  {
    definitionId: toMigrationDefinitionId("articles"),
    error: {
      details: [
        {
          message: "Expected an existing author reference",
          path: "authorId",
        },
      ],
      errorTag: "MissingAuthor",
      kind: "process",
      message: "Could not resolve the article author",
    },
    journal: {
      process: {
        entries: [
          {
            details: { authorId: "author-missing" },
            kind: "diagnostic",
            message: "Author lookup returned no result",
            sequence: 0,
            severity: "warning",
          },
        ],
        runId: previousRunId,
      },
      rollbackAttempts: [],
    },
    lastRunId: previousRunId,
    sourceIdentity: SourceIdentity.fromKey(ContentIdentity, "article-effect"),
    sourceVersion: toSourceVersion("v1"),
    status: "failed",
    updatedAt: finishedAt,
  }
);
state.itemStates.set(
  InMemoryMigrationStore.itemStateKey("assets", "asset-logo"),
  {
    definitionId: toMigrationDefinitionId("assets"),
    lastRunId: previousRunId,
    skipReason: "Asset already exists at the destination",
    sourceIdentity: SourceIdentity.fromKey(ContentIdentity, "asset-logo"),
    sourceVersion: toSourceVersion("v1"),
    status: "skipped",
    updatedAt: finishedAt,
  }
);

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [authors, articles, assets],
  }),
});
