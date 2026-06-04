import { Effect, Schema } from "effect";
import {
  defineMigration,
  InMemoryDestinationPlugin,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  runMigration,
  skipItem,
  type MigrationRunSummary,
  type SourceItemInput,
} from "../index.ts";

const Article = Schema.Struct({
  publish: Schema.Boolean,
  title: Schema.String,
});

type Article = typeof Article.Type;

const UpsertEntryCommand = Schema.Struct({
  kind: Schema.Literal("UpsertEntry"),
  contentType: Schema.String,
  fields: Schema.Record(Schema.String, Schema.Unknown),
});

type UpsertEntryCommand = typeof UpsertEntryCommand.Type;

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
] satisfies readonly SourceItemInput<Article>[];

const makeArticlesMigration = () =>
  defineMigration({
    id: "articles",
    source: InMemorySourcePlugin.make({
      items: sourceItems,
      sourceSchema: Article,
    }),
    destination: InMemoryDestinationPlugin.make({
      commandSchema: UpsertEntryCommand,
      execute: (_command, context) => ({
        destinationIdentity: `entry-${context.sourceIdentity}`,
        destinationVersion: "destination-version-1",
      }),
    }),
    store: InMemoryMigrationStore.layer(),
    pipeline: Effect.fn("articles.pipeline")(function* (source) {
      if (!source.item.publish) {
        return yield* skipItem("Article is not published");
      }

      return {
        kind: "UpsertEntry" as const,
        contentType: "article",
        fields: {
          title: source.item.title,
        },
      };
    }),
  });

export const runInMemoryExample = Effect.fn("runInMemoryExample")(function* () {
  return yield* runMigration(makeArticlesMigration());
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
