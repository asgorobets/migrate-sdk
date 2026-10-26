import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  type MigrationRunSummary,
  SourceIdentity,
} from "migrate-sdk";
import {
  type InMemoryDestinationEntry,
  InMemoryDestinationTesting,
} from "migrate-sdk/destinations/in-memory/testing";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { formatMigrationRunSummary } from "./in-memory-runtime.ts";
import { completedInlineExecution } from "./inline-execution.ts";

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
  readingTimeMinutes: Schema.Finite,
  views: Schema.Finite,
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
  readingTimeMinutes: Schema.Finite,
  seoDescription: Schema.NullOr(Schema.String),
  seoTitle: Schema.String,
  slug: Schema.String,
  tagLabels: Schema.Array(Schema.String),
  title: Schema.String,
  views: Schema.Finite,
});

type ArticleEntryFields = typeof ArticleEntryFields.Type;

export interface NestedArticleSchemaExampleResult {
  readonly entries: readonly InMemoryDestinationEntry<
    "article",
    ArticleEntryFields
  >[];
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
  const recording = InMemoryDestinationTesting.fixtureEntries({
    contentType: "article",
    fields: ArticleEntryFields,
  });

  const migration = MigrationDefinition.make({
    id: "nested-articles",
    source: InMemorySource.make({
      identity: NestedArticleIdentity,
      items: sourceItems,
      sourceSchema: NestedArticle,
    }),
    store: InMemoryMigrationStore.layer(),
    process: Effect.fn("nestedArticles.process")(function* (source) {
      const article = source.item;

      yield* recording.destination.entries.upsert({
        authorDisplayName: article.author.displayName,
        locale: article.locale,
        readingTimeMinutes: article.metrics.readingTimeMinutes,
        seoDescription: article.seo.description ?? null,
        seoTitle: article.seo.title,
        slug: article.slug,
        tagLabels: article.tags.map((tag) => tag.label),
        title: article.title,
        views: article.metrics.views,
      });
    }),
  });

  return { migration, recording };
};

export const runNestedArticleSchemaExample = Effect.fn(
  "runNestedArticleSchemaExample"
)(function* () {
  const { migration, recording } = makeNestedArticleSchemaMigration();
  const registry = MigrationDefinitionRegistry.make({
    definitions: [migration] as const,
  });
  const execution = MigrationExecution.make({ registry });
  const summary = yield* completedInlineExecution(execution.run({ all: true }));

  return {
    entries: [...recording.entries().values()],
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
    "Stored Destination Entries",
    ...result.entries.map(({ entryId, fields }, index) =>
      [
        `article ${index + 1}: ${fields.title}`,
        `entryId: ${entryId}`,
        `author: ${fields.authorDisplayName}`,
        `locale: ${fields.locale}`,
        `seoTitle: ${fields.seoTitle}`,
        ...(fields.seoDescription === null
          ? []
          : [`seoDescription: ${fields.seoDescription}`]),
        `tags: ${fields.tagLabels.join(", ")}`,
        `views: ${fields.views}`,
        `readingTimeMinutes: ${fields.readingTimeMinutes}`,
      ].join("\n")
    ),
  ].join("\n");
