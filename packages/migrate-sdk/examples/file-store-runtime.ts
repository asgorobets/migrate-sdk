import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  defineMigration,
  type MigrationRunSummary,
  runMigration,
  skipItem,
} from "migrate-sdk";
import { InMemoryDestinationPlugin } from "migrate-sdk/destinations/in-memory";
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

const getDefaultStoreDirectory = Effect.fn("getDefaultStoreDirectory")(
  function* () {
    const path = yield* Path;
    const modulePath = yield* path
      .fromFileUrl(new URL(import.meta.url))
      .pipe(Effect.orDie);

    return path.join(path.dirname(modulePath), ".migration-state");
  }
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

const makeArticlesMigration = (storeDirectory: string) => {
  const destinationFixture = InMemoryDestinationPlugin.fixtureEntries({
    schemas: {
      article: ArticleEntryFields,
    },
  });
  const { destination } = destinationFixture;

  const migration = defineMigration({
    destination,
    id: "articles",
    pipeline: Effect.fn("fileStoreArticles.pipeline")(function* (source) {
      if (!source.item.publish) {
        return yield* skipItem("Article is not published");
      }

      return destination.commands.upsertEntry("article", {
        title: source.item.title,
      });
    }),
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
  const defaultStoreDirectory = yield* getDefaultStoreDirectory();
  const storeDirectory =
    options.storeDirectory ??
    process.env.MIGRATE_SDK_FILE_STORE_DIR ??
    defaultStoreDirectory;

  if (options.reset === true) {
    yield* fs.remove(storeDirectory, { force: true, recursive: true });
  }

  const first = makeArticlesMigration(storeDirectory);
  const firstRun = yield* runMigration(first.migration);

  const second = makeArticlesMigration(storeDirectory);
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
