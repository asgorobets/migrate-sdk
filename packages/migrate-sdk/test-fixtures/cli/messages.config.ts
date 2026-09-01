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

const Content = Schema.Struct({ title: Schema.String });
const ContentIdentity = SourceIdentity.make({
  id: "cli-message-content@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});
const storeState = InMemoryMigrationStore.makeState();
const store = InMemoryMigrationStore.layer(storeState);
const runId = toMigrationRunId("run-messages");

const definition = (
  id: string,
  dependencies?: { readonly required: readonly string[] }
) =>
  MigrationDefinition.make({
    ...(dependencies === undefined ? {} : { dependencies }),
    group: "content",
    id,
    process: () => undefined,
    source: InMemorySource.make({
      identity: ContentIdentity,
      items: [],
      sourceSchema: Content,
    }),
    store,
  });

const authors = definition("authors");
const articles = definition("articles", { required: ["authors"] });
const articlesId = toMigrationDefinitionId("articles");
const authorsId = toMigrationDefinitionId("authors");

storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey(articlesId, "article-effect"),
  {
    definitionId: articlesId,
    error: {
      details: [
        { message: "Expected an existing author reference", path: "authorId" },
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
        runId,
      },
      rollbackAttempts: [],
    },
    lastRunId: runId,
    sourceIdentity: SourceIdentity.fromKey(ContentIdentity, "article-effect"),
    sourceVersion: toSourceVersion("v1"),
    status: "failed",
    updatedAt: new Date("2026-08-23T10:00:00.000Z"),
  }
);
storeState.itemStates.set(
  InMemoryMigrationStore.itemStateKey(authorsId, "author-ada"),
  {
    definitionId: authorsId,
    lastRunId: runId,
    skipReason: "Author already exists at the destination",
    sourceIdentity: SourceIdentity.fromKey(ContentIdentity, "author-ada"),
    sourceVersion: toSourceVersion("v1"),
    status: "skipped",
    updatedAt: new Date("2026-08-23T09:00:00.000Z"),
  }
);

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [authors, articles],
  }),
});
