import { Effect, Schema } from "effect";
import {
  defineMigration,
  type MigrationRunSummary,
  runMigration,
  skipItem,
} from "migrate-sdk";
import { InMemoryDestinationPlugin } from "migrate-sdk/destinations/in-memory";
import { InMemorySourcePlugin } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";

const Article = Schema.Struct({
  publish: Schema.Boolean,
  title: Schema.String,
});

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});

const sourceItems = [
  {
    identity: "article-1",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Hello, migration",
    },
  },
  {
    identity: "article-2",
    version: "source-version-1",
    item: {
      publish: false,
      title: "Draft article",
    },
  },
  {
    identity: "article-3",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Second migration article",
    },
  },
] as const;

export const makeInMemoryArticlesMigration = () => {
  const destination = InMemoryDestinationPlugin.makeEntries({
    contentType: "article",
    commands: {
      publishEntry: true,
      upsertEntry: { fields: ArticleEntryFields },
    },
  });

  return defineMigration({
    id: "articles",
    source: InMemorySourcePlugin.make({
      items: sourceItems,
      sourceSchema: Article,
    }),
    destination,
    store: InMemoryMigrationStore.layer(),
    pipeline: Effect.fn("articles.pipeline")(function* (source) {
      if (!source.item.publish) {
        return yield* skipItem("Article is not published");
      }

      return [
        destination.commands.upsertEntry({
          title: source.item.title,
        }),
        destination.commands.publishEntry(),
      ];
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
