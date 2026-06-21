import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  type MigrationRunSummary,
  runMigration,
  SourceIdentity,
  skipItem,
} from "migrate-sdk";
import { InMemoryDestination } from "migrate-sdk/destinations/in-memory";
import { InMemorySourcePlugin } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const Article = Schema.Struct({
  publish: Schema.Boolean,
  title: Schema.String,
});

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "example-article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

const sourceItems = [
  {
    identityKey: "article-1",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Hello, migration",
    },
  },
  {
    identityKey: "article-2",
    version: "source-version-1",
    item: {
      publish: false,
      title: "Draft article",
    },
  },
  {
    identityKey: "article-3",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Second migration article",
    },
  },
] as const;

export const makeInMemoryArticlesMigration = () => {
  const destination = InMemoryDestination.makeEntries({
    contentType: "article",
    fields: ArticleEntryFields,
  });

  return MigrationDefinition.make({
    id: "articles",
    source: InMemorySourcePlugin.make({
      identity: ArticleSourceIdentity,
      items: sourceItems,
      sourceSchema: Article,
    }),
    store: InMemoryMigrationStore.layer(),
    process: Effect.fn("articles.process")(function* (source) {
      if (!source.item.publish) {
        return yield* skipItem("Article is not published");
      }

      yield* destination.entries.upsert({
        title: source.item.title,
      });
    }),
  });
};

export const runInMemoryExample = Effect.fn("runInMemoryExample")(function* () {
  return yield* runMigration(makeInMemoryArticlesMigration());
});

export const formatMigrationRunSummary = (
  summary: MigrationRunSummary
): string => {
  const definitionLines = summary.definitions.map((definition) => {
    const { counts } = definition;

    return [
      `definition: ${definition.definitionId}`,
      `  status: ${definition.status}`,
      `  migrated: ${counts.migrated}`,
      `  skipped: ${counts.skipped}`,
      `  failed: ${counts.failed}`,
      `  unchanged: ${counts.unchanged}`,
      `  needsUpdate: ${counts.needsUpdate}`,
    ].join("\n");
  });

  return [
    "Migration Run Summary",
    `runId: ${summary.runId}`,
    `status: ${summary.status}`,
    ...definitionLines,
  ].join("\n");
};
