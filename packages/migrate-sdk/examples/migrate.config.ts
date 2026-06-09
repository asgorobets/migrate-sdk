import { fileURLToPath } from "node:url";
import { MigrationDefinitionRegistry } from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { makeJsonPlaceholderPostsMigration } from "./api-source/migration.ts";
import { makeCircularBookAuthorStubMigrations } from "./circular-book-author-stubs.ts";
import { makeFileStoreArticlesMigration } from "./file-store-runtime.ts";
import { makeInMemoryArticlesMigration } from "./in-memory-runtime.ts";
import { makeNestedArticleSchemaMigration } from "./nested-article-schema.ts";

const fileStoreDirectory = fileURLToPath(
  new URL("./.migration-state/cli-list", import.meta.url)
);

const fileStoreArticles = makeFileStoreArticlesMigration({
  definitionId: "file-store-articles",
  storeDirectory: fileStoreDirectory,
}).migration;
const nestedArticles = makeNestedArticleSchemaMigration().migration;
const circularStubs = makeCircularBookAuthorStubMigrations();

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [
      makeInMemoryArticlesMigration(),
      fileStoreArticles,
      nestedArticles,
      makeJsonPlaceholderPostsMigration(),
      ...circularStubs.definitions,
    ],
  }),
});
