import { Effect, Schema } from "effect";
import {
  DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationReferenceLookup,
  SourceIdentity,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { writeJson } from "./api-http";
import { apiAuthors } from "./api-to-api";

const ArticleRow = Schema.Struct({
  id: Schema.NonEmptyString,
  title: Schema.NonEmptyString,
  authorId: Schema.NonEmptyString,
});
const articleSource = InMemorySource.make({
  identity: SourceIdentity.make({
    id: "article-id@v1",
    schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
  }),
  sourceSchema: ArticleRow,
  items: [
    {
      identityKey: "article-1",
      version: "1",
      item: { id: "article-1", title: "Meet Ada", authorId: "author-1040" },
    },
  ],
});

export const articles = MigrationDefinition.make({
  id: "articles",
  group: "publishing",
  dependencies: { required: [apiAuthors.id] },
  source: articleSource,
  store: apiAuthors.store,
  process: Effect.fn("processArticle")(function* (sourceItem) {
    const references = yield* MigrationReferenceLookup;
    const author = yield* references.lookup({
      definition: apiAuthors,
      sourceIdentityKey: sourceItem.item.authorId,
    });
    if (author === null || author.status !== "migrated") {
      return yield* new DestinationError({
        message: "Author is not ready for this article",
      });
    }
    yield* writeJson(
      {
        url:
          process.env.ARTICLES_URL ?? "https://directory.example.test/articles",
        token: process.env.DESTINATION_TOKEN,
      },
      `imported-${sourceItem.item.id}`,
      "PUT",
      {
        title: sourceItem.item.title,
        authorId: author.trackingRecord.authorId,
      }
    );
  }),
});

export const registry = MigrationDefinitionRegistry.make({
  definitions: [apiAuthors, articles],
});

export default defineMigrationCliConfig({ registry });
