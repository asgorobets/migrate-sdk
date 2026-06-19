import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  defineMigration,
  type MigrationRunSummary,
  runMigration,
  SourceIdentity,
  skipItem,
} from "migrate-sdk";
import { InMemoryDestination } from "migrate-sdk/destinations/in-memory";
import { InMemorySourcePlugin } from "migrate-sdk/sources/in-memory";
import { FileMigrationStore } from "migrate-sdk/stores/file";
import { formatMigrationRunSummary } from "./in-memory-runtime.ts";

const Article = Schema.Struct({
  publish: Schema.Boolean,
  title: Schema.String,
});

const ArticleEntryFields = Schema.Struct({
  title: Schema.String,
});

const ArticleSourceIdentity = SourceIdentity.make({
  id: "file-store-article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

export interface RunFileStoreExampleOptions {
  readonly reset?: boolean;
  readonly storeDirectory?: string;
}

export interface FileStoreExampleResult {
  readonly firstRun: MigrationRunSummary;
  readonly firstRunProcessedEntries: number;
  readonly secondRun: MigrationRunSummary;
  readonly secondRunProcessedEntries: number;
  readonly storeDirectory: string;
}

export interface MakeFileStoreArticlesMigrationOptions {
  readonly definitionId?: string;
  readonly storeDirectory?: string;
}

const defaultFileStoreDirectory = fileURLToPath(
  new URL("./.migration-state/file-store-articles", import.meta.url)
);

const sourceItems = [
  {
    identityKey: "article:1:en-US",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Hello, file store",
    },
  },
  {
    identityKey: "article:2:en-US",
    version: "source-version-1",
    item: {
      publish: false,
      title: "Draft article",
    },
  },
  {
    identityKey: "article:3:en-US",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Second file-store article",
    },
  },
] as const;

export const makeFileStoreArticlesMigration = ({
  definitionId = "articles",
  storeDirectory = defaultFileStoreDirectory,
}: MakeFileStoreArticlesMigrationOptions = {}) => {
  const destination = InMemoryDestination.makeEntries({
    contentType: "article",
    fields: ArticleEntryFields,
  });
  const processedEntries: Array<typeof ArticleEntryFields.Type> = [];

  const migration = defineMigration({
    id: definitionId,
    process: Effect.fn("fileStoreArticles.process")(function* (source) {
      if (!source.item.publish) {
        return yield* skipItem("Article is not published");
      }

      processedEntries.push({
        title: source.item.title,
      });
      yield* destination.entries.upsert({
        title: source.item.title,
      });
    }),
    rollback: () => undefined,
    source: InMemorySourcePlugin.make({
      identity: ArticleSourceIdentity,
      items: sourceItems,
      sourceSchema: Article,
    }),
    store: FileMigrationStore.layer({ directory: storeDirectory }),
  });

  return { migration, processedEntries };
};

export const runFileStoreExample = Effect.fn("runFileStoreExample")(function* (
  options: RunFileStoreExampleOptions = {}
) {
  const fs = yield* FileSystem;
  const storeDirectory = options.storeDirectory ?? defaultFileStoreDirectory;

  if (options.reset === true) {
    yield* fs.remove(storeDirectory, { force: true, recursive: true });
  }

  const first = makeFileStoreArticlesMigration({ storeDirectory });
  const firstRun = yield* runMigration(first.migration);

  const second = makeFileStoreArticlesMigration({ storeDirectory });
  const secondRun = yield* runMigration(second.migration);

  return {
    firstRun,
    firstRunProcessedEntries: first.processedEntries.length,
    secondRun,
    secondRunProcessedEntries: second.processedEntries.length,
    storeDirectory,
  } satisfies FileStoreExampleResult;
});

export const formatFileStoreExampleResult = (
  result: FileStoreExampleResult
): string =>
  [
    "File Migration Store Smoke",
    `storeDirectory: ${result.storeDirectory}`,
    "",
    "Run A",
    formatMigrationRunSummary(result.firstRun),
    `processed entries: ${result.firstRunProcessedEntries}`,
    "",
    "Run B (fresh destination, same file store)",
    formatMigrationRunSummary(result.secondRun),
    `processed entries: ${result.secondRunProcessedEntries}`,
    "",
    "Inspect persisted records under:",
    result.storeDirectory,
  ].join("\n");
