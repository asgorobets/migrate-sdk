import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  type ProcessPipelineFor,
  type RollbackPipelineFor,
  skipItem,
  Tracking,
} from "migrate-sdk";
import {
  SqlIdentity,
  SqlSource,
  type SqlSourceRead,
  type SqlSourceStatementCount,
} from "migrate-sdk/sources/sql";
import { migrationStore, PostgresLive } from "./database";

interface CountRow {
  readonly count: number | string;
}

const AuthorRow = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  source_version: Schema.Finite,
});
type Author = typeof AuthorRow.Type;
type EncodedAuthor = typeof AuthorRow.Encoded;

const AuthorCursor = Schema.Struct({ id: Schema.NonEmptyString });
type AuthorCursor = typeof AuthorCursor.Type;

const authorIdentity = SqlIdentity.columns({
  columns: [SqlIdentity.column("id", Schema.NonEmptyString)],
  id: "workflow-sdk-author@v1",
});

const readAuthors: SqlSourceRead<EncodedAuthor, AuthorCursor> = (
  sql,
  cursor,
  limit
) =>
  cursor === null
    ? sql`
        SELECT id, name, source_version
        FROM demo_authors_source
        ORDER BY id
        LIMIT ${limit}
      `
    : sql`
        SELECT id, name, source_version
        FROM demo_authors_source
        WHERE id > ${cursor.id}
        ORDER BY id
        LIMIT ${limit}
      `;

const countAuthors: SqlSourceStatementCount<CountRow> = {
  getCount: (row) => Number(row.count),
  kind: "statement",
  statement: (sql) =>
    sql<CountRow>`SELECT COUNT(*) AS count FROM demo_authors_source`,
};

const authorSource = SqlSource.make({
  batchSize: 20,
  count: countAuthors,
  cursorSchema: AuthorCursor,
  getSourceMetadata: (row) => ({
    cursor: { id: row.id },
    kind: "success",
    version: `version-${row.source_version}`,
  }),
  identity: authorIdentity,
  lookup: (sql, identity) => sql`
    SELECT id, name, source_version
    FROM demo_authors_source
    WHERE id = ${identity.key}
  `,
  read: readAuthors,
  sourceSchema: AuthorRow,
}).provide(PostgresLive);

const authorTracking = Tracking.record({
  id: "workflow-sdk-author-destination@v1",
  schema: Schema.Struct({ destinationId: Schema.NonEmptyString }),
});

const writeAuthor = (author: Author) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* Effect.sleep("80 millis");
    yield* sql`
      INSERT INTO demo_authors_destination (id, name, source_version, migrated_at)
      VALUES (${author.id}, ${author.name}, ${author.source_version}, NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name,
        source_version = excluded.source_version,
        migrated_at = excluded.migrated_at
    `;
  }).pipe(
    Effect.provide(PostgresLive),
    Effect.mapError(
      (cause) =>
        new DestinationError({
          cause,
          message: `Unable to write demo author ${author.id}`,
        })
    )
  );

const processAuthor: ProcessPipelineFor<
  typeof authorSource,
  DestinationError,
  typeof authorTracking
> = Effect.fn("workflowSdkExample.processAuthor")(function* (sourceItem) {
  yield* writeAuthor(sourceItem.item);
  yield* Tracking.setRecord({ destinationId: sourceItem.item.id });
});

const rollbackAuthor: RollbackPipelineFor<
  typeof authorTracking,
  DestinationError
> = (state) => {
  const destinationId = state.trackingRecord?.destinationId;

  return destinationId === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM demo_authors_destination WHERE id = ${destinationId}`;
      }).pipe(
        Effect.provide(PostgresLive),
        Effect.mapError(
          (cause) =>
            new DestinationError({
              cause,
              message: `Unable to roll back demo author ${destinationId}`,
            })
        )
      );
};

export const authors = MigrationDefinition.make({
  execution: { process: { concurrency: 2 } },
  group: "catalog",
  id: "authors",
  process: processAuthor,
  rollback: rollbackAuthor,
  source: authorSource,
  store: migrationStore,
  tracking: authorTracking,
});

const BookRow = Schema.Struct({
  author_id: Schema.NonEmptyString,
  disposition: Schema.Literals([
    "fail-reference",
    "invalid",
    "migrate",
    "skip",
  ]),
  id: Schema.NonEmptyString,
  publication_year: Schema.NonEmptyString,
  source_version: Schema.Finite,
  title: Schema.String,
  wikidata_work_id: Schema.NonEmptyString,
});
type Book = typeof BookRow.Type;
type EncodedBook = typeof BookRow.Encoded;

const BookCursor = Schema.Struct({ id: Schema.NonEmptyString });
type BookCursor = typeof BookCursor.Type;

const bookIdentity = SqlIdentity.columns({
  columns: [SqlIdentity.column("id", Schema.NonEmptyString)],
  id: "workflow-sdk-book@v1",
});

const readBooks: SqlSourceRead<EncodedBook, BookCursor> = (
  sql,
  cursor,
  limit
) =>
  cursor === null
    ? sql`
        SELECT id, title, author_id, disposition, publication_year,
               source_version, wikidata_work_id
        FROM demo_books_source
        ORDER BY id
        LIMIT ${limit}
      `
    : sql`
        SELECT id, title, author_id, disposition, publication_year,
               source_version, wikidata_work_id
        FROM demo_books_source
        WHERE id > ${cursor.id}
        ORDER BY id
        LIMIT ${limit}
      `;

const countBooks: SqlSourceStatementCount<CountRow> = {
  getCount: (row) => Number(row.count),
  kind: "statement",
  statement: (sql) =>
    sql<CountRow>`SELECT COUNT(*) AS count FROM demo_books_source`,
};

const bookSource = SqlSource.make({
  batchSize: 40,
  count: countBooks,
  cursorSchema: BookCursor,
  getSourceMetadata: (row) => ({
    cursor: { id: row.id },
    kind: "success",
    version: `version-${row.source_version}`,
  }),
  identity: bookIdentity,
  lookup: (sql, identity) => sql`
    SELECT id, title, author_id, disposition, publication_year,
           source_version, wikidata_work_id
    FROM demo_books_source
    WHERE id = ${identity.key}
  `,
  read: readBooks,
  sourceSchema: BookRow,
}).provide(PostgresLive);

const bookTracking = Tracking.record({
  id: "workflow-sdk-book-destination@v1",
  schema: Schema.Struct({ destinationId: Schema.NonEmptyString }),
});

class CatalogReferenceError extends Schema.TaggedError<CatalogReferenceError>()(
  "CatalogReferenceError",
  {
    message: Schema.String,
    referenceId: Schema.String,
  }
) {}

class CatalogValidationError extends Schema.TaggedError<CatalogValidationError>()(
  "CatalogValidationError",
  {
    message: Schema.String,
    publicationYear: Schema.Number,
  }
) {}

interface DestinationIdRow {
  readonly id: string;
}

const writeBook = (book: Book) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* Effect.sleep("80 millis");
    yield* sql`
      INSERT INTO demo_books_destination (
        id,
        title,
        author_id,
        source_version,
        migrated_at
      )
      VALUES (
        ${book.id},
        ${book.title},
        ${book.author_id},
        ${book.source_version},
        NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        title = excluded.title,
        author_id = excluded.author_id,
        source_version = excluded.source_version,
        migrated_at = excluded.migrated_at
    `;
  }).pipe(
    Effect.provide(PostgresLive),
    Effect.mapError(
      (cause) =>
        new DestinationError({
          cause,
          message: `Unable to write demo book ${book.id}`,
        })
    )
  );

const processBook: ProcessPipelineFor<
  typeof bookSource,
  | CatalogReferenceError
  | CatalogValidationError
  | DestinationError
  | Schema.SchemaError,
  typeof bookTracking
> = Effect.fn("workflowSdkExample.processBook")(function* (sourceItem) {
  if (sourceItem.item.disposition === "skip") {
    return yield* skipItem("Book is outside the catalog publishing scope");
  }

  const publicationYear = Number.parseInt(sourceItem.item.publication_year, 10);
  if (
    sourceItem.item.disposition === "invalid" ||
    !Number.isSafeInteger(publicationYear) ||
    publicationYear > 2100
  ) {
    yield* Tracking.logDiagnostic({
      details: {
        publicationYear,
        wikidataWorkId: sourceItem.item.wikidata_work_id,
      },
      message: "Publication year is outside the supported catalog range",
      severity: "error",
    });
    return yield* new CatalogValidationError({
      message: "Book publication year must not be later than 2100",
      publicationYear,
    });
  }

  const author = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<DestinationIdRow>`
      SELECT id
      FROM demo_authors_destination
      WHERE id = ${sourceItem.item.author_id}
    `;
  }).pipe(
    Effect.provide(PostgresLive),
    Effect.mapError(
      (cause) =>
        new DestinationError({
          cause,
          message: `Unable to read demo author ${sourceItem.item.author_id}`,
        })
    )
  );
  if (author[0]?.id === undefined) {
    yield* Tracking.logDiagnostic({
      details: { authorId: sourceItem.item.author_id },
      message: "Author reference was not found",
      severity: "error",
    });
    return yield* new CatalogReferenceError({
      message: "Book author must be migrated before the book",
      referenceId: sourceItem.item.author_id,
    });
  }

  yield* writeBook(sourceItem.item);
  yield* Tracking.setRecord({ destinationId: sourceItem.item.id });
});

const rollbackBook: RollbackPipelineFor<
  typeof bookTracking,
  DestinationError
> = (state) => {
  const destinationId = state.trackingRecord?.destinationId;

  return destinationId === undefined
    ? Effect.void
    : Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM demo_books_destination WHERE id = ${destinationId}`;
      }).pipe(
        Effect.provide(PostgresLive),
        Effect.mapError(
          (cause) =>
            new DestinationError({
              cause,
              message: `Unable to roll back demo book ${destinationId}`,
            })
        )
      );
};

export const books = MigrationDefinition.make({
  dependencies: { required: [authors.id] },
  execution: { process: { concurrency: 4 } },
  group: "catalog",
  id: "books",
  process: processBook,
  rollback: rollbackBook,
  source: bookSource,
  store: migrationStore,
  tracking: bookTracking,
});

export const catalogRegistryId = "workflow-sdk-catalog";

export const catalogRegistry = MigrationDefinitionRegistry.make({
  definitions: [authors, books] as const,
  id: catalogRegistryId,
});
