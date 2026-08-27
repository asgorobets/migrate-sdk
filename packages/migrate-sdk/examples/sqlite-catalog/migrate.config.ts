import { fileURLToPath } from "node:url";
import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Config, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import {
  DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  type RollbackPipelineFor,
  skipItem,
  Tracking,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { CsvIdentity, CsvSource } from "migrate-sdk/sources/csv";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const CatalogBookSourceRow = Schema.Struct({
  author_id: Schema.String,
  canonical_author_id: Schema.String,
  canonical_publication_year: Schema.String,
  disposition: Schema.Literals([
    "fail-reference",
    "invalid",
    "migrate",
    "skip",
  ]),
  id: Schema.String,
  isbn: Schema.String,
  publication_year: Schema.String,
  publisher_id: Schema.String,
  source_version: Schema.String,
  subject_id: Schema.String,
  title: Schema.String,
  wikidata_work_id: Schema.String,
});

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const tablePrefix = "catalog_demo";
const filePlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);
const fixtureSettings = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    const dataDirectory = yield* Config.string(
      "MIGRATE_SQLITE_CATALOG_DIR"
    ).pipe(Config.withDefault(path.join(fixtureDirectory, ".data")));
    const requestedDelay = yield* Config.int(
      "MIGRATE_SQLITE_CATALOG_DELAY_MS"
    ).pipe(Config.withDefault(10));

    if (requestedDelay < 0) {
      return yield* Effect.die(
        "MIGRATE_SQLITE_CATALOG_DELAY_MS must be a non-negative integer"
      );
    }

    const sourceDirectory = path.join(dataDirectory, "sources");
    const statePath = path.join(dataDirectory, "state.sqlite");
    const destinationPath = path.join(dataDirectory, "destination.sqlite");

    for (const requiredPath of [sourceDirectory, statePath, destinationPath]) {
      if (!(yield* fs.exists(requiredPath))) {
        return yield* Effect.die(
          `SQLite catalog fixture is not set up. Run "pnpm --filter migrate-sdk demo:sqlite-catalog:setup" first. Missing ${requiredPath}`
        );
      }
    }

    return {
      destinationPath,
      requestedDelay,
      sourcePath: (fileName: string) => path.join(sourceDirectory, fileName),
      statePath,
    };
  }).pipe(Effect.provide(filePlatformLayer))
);
const { destinationPath, requestedDelay, statePath } = fixtureSettings;
const stateSqlLayer = SqliteClient.layer({
  filename: statePath,
});
const destinationSqlLayer = SqliteClient.layer({
  filename: destinationPath,
});
const store = SqlMigrationStore.layerFromClient(stateSqlLayer, {
  initialize: false,
  tablePrefix,
});

const EntitySourceRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  source_version: Schema.String,
});

const DestinationRecord = Schema.Struct({
  destinationId: Schema.String,
});

const authorTracking = Tracking.record({
  id: "sqlite-catalog-author@v1",
  schema: DestinationRecord,
});
const publisherTracking = Tracking.record({
  id: "sqlite-catalog-publisher@v1",
  schema: DestinationRecord,
});
const subjectTracking = Tracking.record({
  id: "sqlite-catalog-subject@v1",
  schema: DestinationRecord,
});
const bookTracking = Tracking.record({
  id: "sqlite-catalog-book@v1",
  schema: DestinationRecord,
});

class CatalogReferenceError extends Schema.TaggedError<CatalogReferenceError>()(
  "CatalogReferenceError",
  {
    message: Schema.String,
    referenceId: Schema.String,
    referenceType: Schema.String,
  }
) {}

class CatalogValidationError extends Schema.TaggedError<CatalogValidationError>()(
  "CatalogValidationError",
  {
    message: Schema.String,
    // The pipeline validates the parsed year before constructing this error.
    // @effect-diagnostics-next-line schemaNumber:off
    publicationYear: Schema.Number,
  }
) {}

interface DestinationIdRow {
  readonly id: string;
}

const csvSource = <Payload>(options: {
  readonly fileName: string;
  readonly identityId: string;
  readonly schema: Schema.Codec<Payload, Record<string, string>>;
}) =>
  CsvSource.make({
    batchSize: 100,
    dialect: { kind: "standard" },
    emptyRows: { kind: "skip" },
    headers: { kind: "from-row", rowIndex: 0 },
    identity: CsvIdentity.column({
      column: "id",
      id: options.identityId,
    }),
    path: fixtureSettings.sourcePath(options.fileName),
    platform: filePlatformLayer,
    sourceSchema: options.schema,
    version: { column: "source_version", kind: "column" },
  });

const destinationOperation = <A>(
  message: string,
  operation: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>
): Effect.Effect<A, DestinationError> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA foreign_keys = ON");
    return yield* operation(sql);
  }).pipe(
    Effect.provide(destinationSqlLayer),
    Effect.mapError((cause) => new DestinationError({ cause, message }))
  );

const delay = requestedDelay === 0 ? Effect.void : Effect.sleep(requestedDelay);

const authorsSource = csvSource({
  fileName: "authors.csv",
  identityId: "sqlite-catalog-author-source@v1",
  schema: EntitySourceRow,
});
const publishersSource = csvSource({
  fileName: "publishers.csv",
  identityId: "sqlite-catalog-publisher-source@v1",
  schema: EntitySourceRow,
});
const subjectsSource = csvSource({
  fileName: "subjects.csv",
  identityId: "sqlite-catalog-subject-source@v1",
  schema: EntitySourceRow,
});
const booksSource = csvSource({
  fileName: "books.csv",
  identityId: "sqlite-catalog-book-source@v1",
  schema: CatalogBookSourceRow,
});

const authors = MigrationDefinition.make({
  group: "catalog",
  id: "authors",
  process: Effect.fn("sqliteCatalog.authors.process")(function* (source) {
    yield* delay;
    yield* destinationOperation(
      "Unable to write catalog author",
      (sql) =>
        sql`
        INSERT INTO catalog_authors (id, name)
        VALUES (${source.item.id}, ${source.item.name})
        ON CONFLICT (id) DO UPDATE SET name = excluded.name
      `
    );
    yield* Tracking.setRecord({ destinationId: source.item.id });
  }),
  rollback: ((state) => {
    const record = state.trackingRecord;
    return record === undefined
      ? Effect.void
      : destinationOperation(
          "Unable to roll back catalog author",
          (sql) =>
            sql`DELETE FROM catalog_authors WHERE id = ${record.destinationId}`
        );
  }) satisfies RollbackPipelineFor<typeof authorTracking, DestinationError>,
  source: authorsSource,
  store,
  tracking: authorTracking,
});

const publishers = MigrationDefinition.make({
  group: "catalog",
  id: "publishers",
  process: Effect.fn("sqliteCatalog.publishers.process")(function* (source) {
    yield* delay;
    yield* destinationOperation(
      "Unable to write catalog publisher",
      (sql) =>
        sql`
        INSERT INTO catalog_publishers (id, name)
        VALUES (${source.item.id}, ${source.item.name})
        ON CONFLICT (id) DO UPDATE SET name = excluded.name
      `
    );
    yield* Tracking.setRecord({ destinationId: source.item.id });
  }),
  rollback: ((state) => {
    const record = state.trackingRecord;
    return record === undefined
      ? Effect.void
      : destinationOperation(
          "Unable to roll back catalog publisher",
          (sql) =>
            sql`DELETE FROM catalog_publishers WHERE id = ${record.destinationId}`
        );
  }) satisfies RollbackPipelineFor<typeof publisherTracking, DestinationError>,
  source: publishersSource,
  store,
  tracking: publisherTracking,
});

const subjects = MigrationDefinition.make({
  group: "catalog",
  id: "subjects",
  process: Effect.fn("sqliteCatalog.subjects.process")(function* (source) {
    yield* delay;
    yield* destinationOperation(
      "Unable to write catalog subject",
      (sql) =>
        sql`
        INSERT INTO catalog_subjects (id, name)
        VALUES (${source.item.id}, ${source.item.name})
        ON CONFLICT (id) DO UPDATE SET name = excluded.name
      `
    );
    yield* Tracking.setRecord({ destinationId: source.item.id });
  }),
  rollback: ((state) => {
    const record = state.trackingRecord;
    return record === undefined
      ? Effect.void
      : destinationOperation(
          "Unable to roll back catalog subject",
          (sql) =>
            sql`DELETE FROM catalog_subjects WHERE id = ${record.destinationId}`
        );
  }) satisfies RollbackPipelineFor<typeof subjectTracking, DestinationError>,
  source: subjectsSource,
  store,
  tracking: subjectTracking,
});

const books = MigrationDefinition.make({
  dependencies: {
    optional: [subjects.id],
    required: [authors.id, publishers.id],
  },
  group: "catalog",
  id: "books",
  process: Effect.fn("sqliteCatalog.books.process")(function* (source) {
    if (source.item.disposition === "skip") {
      return yield* skipItem("Book is outside the catalog publishing scope");
    }

    yield* delay;

    const publicationYear = Number.parseInt(source.item.publication_year, 10);

    if (
      source.item.disposition === "invalid" ||
      !Number.isSafeInteger(publicationYear) ||
      publicationYear > 2100
    ) {
      yield* Tracking.logDiagnostic({
        details: {
          publicationYear,
          wikidataWorkId: source.item.wikidata_work_id,
        },
        message: "Publication year is outside the supported catalog range",
        severity: "error",
      });
      return yield* new CatalogValidationError({
        message: "Book publication year must not be later than 2100",
        publicationYear,
      });
    }

    const author = yield* destinationOperation(
      "Unable to read catalog author reference",
      (sql) =>
        sql<DestinationIdRow>`
          SELECT id FROM catalog_authors WHERE id = ${source.item.author_id}
        `
    );
    const authorId = author[0]?.id;
    if (authorId === undefined) {
      yield* Tracking.logDiagnostic({
        details: { authorId: source.item.author_id },
        message: "Author reference was not found",
        severity: "error",
      });
      return yield* new CatalogReferenceError({
        message: "Book author must be migrated before the book",
        referenceId: source.item.author_id,
        referenceType: "author",
      });
    }

    const publisher = yield* destinationOperation(
      "Unable to read catalog publisher reference",
      (sql) =>
        sql<DestinationIdRow>`
          SELECT id FROM catalog_publishers WHERE id = ${source.item.publisher_id}
        `
    );
    const publisherId = publisher[0]?.id;
    if (publisherId === undefined) {
      return yield* new CatalogReferenceError({
        message: "Book publisher must be migrated before the book",
        referenceId: source.item.publisher_id,
        referenceType: "publisher",
      });
    }

    const subject = yield* destinationOperation(
      "Unable to read optional catalog subject reference",
      (sql) =>
        sql<DestinationIdRow>`
          SELECT id FROM catalog_subjects WHERE id = ${source.item.subject_id}
        `
    );
    const subjectId = subject[0]?.id;
    if (subjectId === undefined) {
      yield* Tracking.logDiagnostic({
        details: { subjectId: source.item.subject_id },
        message: "Optional subject was not migrated; publishing without it",
        severity: "warning",
      });
    }

    yield* destinationOperation(
      "Unable to write catalog book",
      (sql) =>
        sql`
        INSERT INTO catalog_books (
          id,
          title,
          author_id,
          publisher_id,
          subject_id,
          publication_year,
          isbn,
          wikidata_work_id
        ) VALUES (
          ${source.item.id},
          ${source.item.title},
          ${authorId},
          ${publisherId},
          ${subjectId ?? null},
          ${publicationYear},
          ${source.item.isbn},
          ${source.item.wikidata_work_id}
        )
        ON CONFLICT (id) DO UPDATE SET
          title = excluded.title,
          author_id = excluded.author_id,
          publisher_id = excluded.publisher_id,
          subject_id = excluded.subject_id,
          publication_year = excluded.publication_year,
          isbn = excluded.isbn,
          wikidata_work_id = excluded.wikidata_work_id
      `
    );
    yield* Tracking.setRecord({ destinationId: source.item.id });
  }),
  rollback: ((state) => {
    const record = state.trackingRecord;
    return record === undefined
      ? Effect.void
      : destinationOperation(
          "Unable to roll back catalog book",
          (sql) =>
            sql`DELETE FROM catalog_books WHERE id = ${record.destinationId}`
        );
  }) satisfies RollbackPipelineFor<typeof bookTracking, DestinationError>,
  source: booksSource,
  store,
  tracking: bookTracking,
});

const registry = MigrationDefinitionRegistry.make({
  definitions: [authors, publishers, subjects, books],
  id: "sqlite-catalog-demo",
});

export default defineMigrationCliConfig({
  registry,
  sqlStore: {
    clientLayer: stateSqlLayer,
    tablePrefix,
  },
});
