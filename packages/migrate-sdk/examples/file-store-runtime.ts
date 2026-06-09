import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
  defineMigration,
  type MigrationRunSummary,
  runMigration,
  skipItem,
} from "migrate-sdk";
import { InMemoryDestinationTesting } from "migrate-sdk/destinations/in-memory/testing";
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

export interface RunFileStoreExampleOptions {
  readonly reset?: boolean;
  readonly storeDirectory?: string;
}

export interface FileStoreExampleResult {
  readonly firstRun: MigrationRunSummary;
  readonly firstRunDestinationExecutions: number;
  readonly secondRun: MigrationRunSummary;
  readonly secondRunDestinationExecutions: number;
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
    identity: "article:1:en-US",
    version: "source-version-1",
    item: {
      publish: true,
      title: "Hello, file store",
    },
  },
  {
    identity: "article:2:en-US",
    version: "source-version-1",
    item: {
      publish: false,
      title: "Draft article",
    },
  },
  {
    identity: "article:3:en-US",
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
  const destinationFixture = InMemoryDestinationTesting.fixtureEntries({
    contentType: "article",
    commands: {
      deleteEntry: true,
      publishEntry: true,
      upsertEntry: { fields: ArticleEntryFields },
    },
  });
  const { destination } = destinationFixture;

  const migration = defineMigration({
    destination,
    id: definitionId,
    pipeline: Effect.fn("fileStoreArticles.pipeline")(function* (source) {
      if (!source.item.publish) {
        return yield* skipItem("Article is not published");
      }

      return destination.commands.upsertEntry({
        title: source.item.title,
      });
    }),
    rollback: () => destination.commands.deleteEntry(),
    source: InMemorySourcePlugin.make({
      items: sourceItems,
      sourceSchema: Article,
    }),
    store: FileMigrationStore.layer({ directory: storeDirectory }),
  });

  return { destinationFixture, migration };
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
    firstRunDestinationExecutions: first.destinationFixture.executions().length,
    secondRun,
    secondRunDestinationExecutions:
      second.destinationFixture.executions().length,
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
    `destination executions: ${result.firstRunDestinationExecutions}`,
    "",
    "Run B (fresh destination, same file store)",
    formatMigrationRunSummary(result.secondRun),
    `destination executions: ${result.secondRunDestinationExecutions}`,
    "",
    "Inspect persisted records under:",
    result.storeDirectory,
  ].join("\n");
