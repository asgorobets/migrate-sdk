import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  type MigrationRunSummary,
  runMigration,
  SourceIdentity,
} from "migrate-sdk";
import { InMemorySourcePlugin } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { formatMigrationRunSummary } from "./in-memory-runtime.ts";

const ArticleLocale = Schema.Literals(["en-US", "fr-FR"]);

const ArticleAuthor = Schema.Struct({
  displayName: Schema.String,
  id: Schema.String,
});

const ArticleSeo = Schema.Struct({
  description: Schema.optional(Schema.String),
  title: Schema.String,
});

const ArticleTag = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
});

const ArticleMetrics = Schema.Struct({
  readingTimeMinutes: Schema.Number,
  views: Schema.Number,
});

const NestedArticle = Schema.Struct({
  author: ArticleAuthor,
  locale: ArticleLocale,
  metrics: ArticleMetrics,
  seo: ArticleSeo,
  slug: Schema.String,
  status: Schema.Literals(["draft", "published"]),
  tags: Schema.Array(ArticleTag),
  title: Schema.Trim,
});

const NestedArticleIdentity = SourceIdentity.make({
  id: "nested-article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

const ArticleEntryFields = Schema.Struct({
  authorDisplayName: Schema.String,
  locale: ArticleLocale,
  readingTimeMinutes: Schema.Number,
  seoDescription: Schema.optional(Schema.String),
  seoTitle: Schema.String,
  slug: Schema.String,
  tagLabels: Schema.Array(Schema.String),
  title: Schema.String,
  views: Schema.Number,
});

type ArticleEntryFields = typeof ArticleEntryFields.Type;

export interface NestedArticleSchemaExampleResult {
  readonly commandFields: readonly ArticleEntryFields[];
  readonly summary: MigrationRunSummary;
}

const sourceItems = [
  {
    identityKey: "article:schema-first:en-US",
    version: "source-version-1",
    item: {
      author: {
        displayName: "Ada Lovelace",
        id: "author:ada-lovelace",
      },
      locale: "en-US",
      metrics: {
        readingTimeMinutes: 7,
        views: 1280,
      },
      seo: {
        description: "A realistic source payload with nested fields",
        title: "Schema-first migrations",
      },
      slug: "schema-first-migrations",
      status: "published",
      tags: [
        { key: "effect", label: "Effect" },
        { key: "schemas", label: "Schemas" },
      ],
      title: "  Schema-first migrations  ",
    },
  },
] as const;

export const makeNestedArticleSchemaMigration = () => {
  const commandFields: ArticleEntryFields[] = [];

  const migration = MigrationDefinition.make({
    id: "nested-articles",
    source: InMemorySourcePlugin.make({
      identity: NestedArticleIdentity,
      items: sourceItems,
      sourceSchema: NestedArticle,
    }),
    store: InMemoryMigrationStore.layer(),
    process: (source) => {
      const article = source.item;
      const authorDisplayName = article.author.displayName;
      const tagLabels = article.tags.map((tag) => tag.label);
      const views = article.metrics.views;
      const readingTimeMinutes = article.metrics.readingTimeMinutes;

      commandFields.push({
        authorDisplayName,
        locale: article.locale,
        readingTimeMinutes,
        seoDescription: article.seo.description,
        seoTitle: article.seo.title,
        slug: article.slug,
        tagLabels,
        title: article.title,
        views,
      });
    },
  });

  return { commandFields, migration };
};

export const runNestedArticleSchemaExample = Effect.fn(
  "runNestedArticleSchemaExample"
)(function* () {
  const { commandFields, migration } = makeNestedArticleSchemaMigration();
  const summary = yield* runMigration(migration);

  return {
    commandFields,
    summary,
  } satisfies NestedArticleSchemaExampleResult;
});

export const formatNestedArticleSchemaExampleResult = (
  result: NestedArticleSchemaExampleResult
): string =>
  [
    "Nested Article Source Schema Example",
    formatMigrationRunSummary(result.summary),
    "",
    "Decoded Destination Entry Fields",
    ...result.commandFields.map((fields, index) =>
      [
        `article ${index + 1}: ${fields.title}`,
        `author: ${fields.authorDisplayName}`,
        `locale: ${fields.locale}`,
        `seoTitle: ${fields.seoTitle}`,
        ...(fields.seoDescription === undefined
          ? []
          : [`seoDescription: ${fields.seoDescription}`]),
        `tags: ${fields.tagLabels.join(", ")}`,
        `views: ${fields.views}`,
        `readingTimeMinutes: ${fields.readingTimeMinutes}`,
      ].join("\n")
    ),
  ].join("\n");
