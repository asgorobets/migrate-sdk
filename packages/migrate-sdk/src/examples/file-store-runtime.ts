import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  defineMigration,
  FileMigrationStore,
  InMemoryDestinationPlugin,
  InMemorySourcePlugin,
  type MigrationRunSummary,
  runMigration,
  type SourceItemInput,
  skipItem,
} from "../index.ts";
import { formatMigrationRunSummary } from "./in-memory-runtime.ts";

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
    const repoRoot = path.resolve(path.dirname(modulePath), "../../../..");

    return path.join(
      repoRoot,
      "packages",
      "migrate-sdk",
      "examples",
      ".migration-state"
    );
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
] satisfies readonly SourceItemInput<Article>[];

const makeArticlesMigration = (
  storeDirectory: string,
  destinationState: ReturnType<
    typeof InMemoryDestinationPlugin.makeState<UpsertEntryCommand>
  >
) =>
  defineMigration({
    id: "articles",
    source: InMemorySourcePlugin.make({
      items: sourceItems,
      sourceSchema: Article,
    }),
    destination: InMemoryDestinationPlugin.make({
      commandSchema: UpsertEntryCommand,
      state: destinationState,
      execute: (_command, context) => ({
        destinationIdentity: `entry-${context.sourceIdentity}`,
        destinationVersion: "destination-version-1",
      }),
    }),
    store: FileMigrationStore.layer({ directory: storeDirectory }),
    pipeline: Effect.fn("fileStoreArticles.pipeline")(function* (source) {
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

  const firstRunDestinationState =
    InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
  const firstRun = yield* runMigration(
    makeArticlesMigration(storeDirectory, firstRunDestinationState)
  );

  const secondRunDestinationState =
    InMemoryDestinationPlugin.makeState<UpsertEntryCommand>();
  const secondRun = yield* runMigration(
    makeArticlesMigration(storeDirectory, secondRunDestinationState)
  );

  return {
    firstRun,
    firstRunDestinationExecutions: firstRunDestinationState.executions.length,
    secondRun,
    secondRunDestinationExecutions: secondRunDestinationState.executions.length,
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
