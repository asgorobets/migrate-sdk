import { fileURLToPath } from "node:url";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { Effect, Layer, Schema } from "effect";
import {
  InMemoryMigrationStore,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  Source,
  SourceIdentity,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { CsvIdentity, CsvSource } from "migrate-sdk/sources/csv";
import {
  DocumentFetchers,
  DocumentParsers,
  DocumentSource,
  type DocumentSourceIdentity,
  type DocumentSourceSelectedItem,
} from "migrate-sdk/sources/document";
import { InMemorySource } from "migrate-sdk/sources/in-memory";

const filePlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);
const store = InMemoryMigrationStore.layer();

const fixturePath = (fileName: string) =>
  fileURLToPath(
    new URL(`./source-total-progress/${fileName}`, import.meta.url)
  );

const Article = Schema.Struct({
  publish: Schema.Boolean,
  title: Schema.String,
});

const ArticleIdentity = SourceIdentity.make({
  id: "progress-article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

const inMemoryArticles = MigrationDefinition.make({
  id: "totals-in-memory",
  source: InMemorySource.make({
    batchSize: 2,
    identity: ArticleIdentity,
    items: [
      {
        identityKey: "article-1",
        item: { publish: true, title: "One" },
        version: "source-version-1",
      },
      {
        identityKey: "article-2",
        item: { publish: true, title: "Two" },
        version: "source-version-1",
      },
      {
        identityKey: "article-3",
        item: { publish: true, title: "Three" },
        version: "source-version-1",
      },
    ],
    sourceSchema: Article,
  }),
  store,
  process: () => undefined,
});

const Book = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
});

const csvBooks = MigrationDefinition.make({
  id: "totals-csv",
  source: CsvSource.make({
    dialect: { kind: "standard" },
    emptyRows: { kind: "skip" },
    headers: { kind: "from-row", rowIndex: 0 },
    identity: CsvIdentity.column({
      column: "id",
      id: "progress-csv-book@v1",
    }),
    path: fixturePath("books.csv"),
    platform: filePlatformLayer,
    sourceSchema: Book,
    version: { kind: "row-hash" },
  }),
  store,
  process: () => undefined,
});

const Company = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
});
type Company = typeof Company.Type;

const CompaniesDocument = Schema.Struct({
  companies: Schema.Array(Company),
});

const CompanyIdentity: DocumentSourceIdentity<
  DocumentSourceSelectedItem<Company>,
  string
> = {
  id: "progress-company@v1",
  key: ({ item }) => item.key,
  schema: SourceIdentity.key("companyKey", Schema.NonEmptyString),
};

const companies = MigrationDefinition.make({
  id: "totals-document",
  source: DocumentSource.make({
    fetcher: DocumentFetchers.fileText({
      path: fixturePath("companies.json"),
      platform: filePlatformLayer,
    }),
    identity: CompanyIdentity,
    lookup: { kind: "scan" },
    parser: DocumentParsers.json(CompaniesDocument),
    selector: {
      item: (document) => document.companies,
    },
    version: { kind: "content-hash" },
  }),
  store,
  process: () => undefined,
});

const unsupportedTotalSource = Source.make({
  cursorSchema: Schema.Null,
  identity: SourceIdentity.make({
    id: "progress-unsupported-total@v1",
    schema: SourceIdentity.key("recordId", Schema.NonEmptyString),
  }),
  lookupStrategy: "scan",
  read: () =>
    Effect.succeed({
      items: [
        {
          identityKey: "record-1",
          item: { title: "Unknown total example" },
          version: "source-version-1",
        },
      ],
    }),
  readByIdentity: () => Effect.succeed(null),
  sourceSchema: Schema.Struct({
    title: Schema.String,
  }),
});

const unknownTotal = MigrationDefinition.make({
  id: "totals-unknown",
  source: unsupportedTotalSource,
  store,
  process: () => undefined,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [inMemoryArticles, csvBooks, companies, unknownTotal],
  }),
});
