import { Effect, Schema } from "effect";
import {
  defineMigration,
  InMemoryDestinationPlugin,
  type InMemoryEntryCommand,
  InMemoryMigrationStore,
  InMemorySourcePlugin,
  type MigrationRunSummary,
  runMigration,
  type SourceItemInput,
} from "../index.ts";
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

type NestedArticle = typeof NestedArticle.Type;

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

interface ArticleEntrySchemas {
  readonly article: typeof ArticleEntryFields;
}
type ArticleEntryCommand = InMemoryEntryCommand<ArticleEntrySchemas>;
type ArticleEntryFields = typeof ArticleEntryFields.Type;

export interface NestedArticleSchemaExampleResult {
  readonly commandFields: readonly ArticleEntryFields[];
  readonly summary: MigrationRunSummary;
}

const sourceItems = [
  {
    identity: "article:schema-first:en-US",
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
] satisfies readonly SourceItemInput<NestedArticle>[];

export const runNestedArticleSchemaExample = Effect.fn(
  "runNestedArticleSchemaExample"
)(function* () {
  const destinationState =
    InMemoryDestinationPlugin.makeState<ArticleEntryCommand>();
  const destination = InMemoryDestinationPlugin.makeEntries({
    schemas: {
      article: ArticleEntryFields,
    },
    state: destinationState,
  });

  const migration = defineMigration({
    id: "nested-articles",
    source: InMemorySourcePlugin.make({
      items: sourceItems,
      sourceSchema: NestedArticle,
    }),
    destination,
    store: InMemoryMigrationStore.layer(),
    pipeline: Effect.fn("nestedArticles.pipeline")(function* (source) {
      const article: NestedArticle = source.item;
      const authorDisplayName: string = article.author.displayName;
      const tagLabels: readonly string[] = article.tags.map((tag) => tag.label);
      const views: number = article.metrics.views;
      const readingTimeMinutes: number = article.metrics.readingTimeMinutes;

      return destination.commands.upsertEntry("article", {
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
    }),
  });

  const summary = yield* runMigration(migration);

  return {
    commandFields: destinationState.executions.flatMap((execution) =>
      execution.command.kind === "UpsertEntry" ? [execution.command.fields] : []
    ),
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
    "Decoded Destination Command Fields",
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
