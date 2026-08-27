import { loadCatalogFixture } from "@fixtures/catalog";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";
import {
  migrationStoreTablePrefix,
  PostgresLive,
} from "../migrations/database";

export interface DemoDatabaseCounts {
  readonly authors: number;
  readonly books: number;
}

const readCount = (value: unknown): number => Number(value);

const resetDemoDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const prefix = migrationStoreTablePrefix;

  yield* sql.unsafe(`
    DROP TABLE IF EXISTS ${prefix}_latest_runs CASCADE;
    DROP TABLE IF EXISTS ${prefix}_locks CASCADE;
    DROP TABLE IF EXISTS ${prefix}_item_states CASCADE;
    DROP TABLE IF EXISTS ${prefix}_cursors CASCADE;
    DROP TABLE IF EXISTS ${prefix}_contracts CASCADE;
    DROP TABLE IF EXISTS ${prefix}_run_definitions CASCADE;
    DROP TABLE IF EXISTS ${prefix}_runs CASCADE;
    DROP TABLE IF EXISTS ${prefix}_schema_migrations CASCADE;
    DROP TABLE IF EXISTS demo_books_destination CASCADE;
    DROP TABLE IF EXISTS demo_authors_destination CASCADE;
    DROP TABLE IF EXISTS demo_books_source CASCADE;
    DROP TABLE IF EXISTS demo_authors_source CASCADE;
  `);
});

const createAndSeedDemoTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fixture = yield* Effect.promise(() =>
    loadCatalogFixture({ bookCount: 240, outcomes: "all-migrate" })
  );

  yield* sql`
    CREATE TABLE IF NOT EXISTS demo_authors_source (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_version INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS demo_books_source (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author_id TEXT NOT NULL REFERENCES demo_authors_source(id),
      source_version INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS demo_authors_destination (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      migrated_at TIMESTAMPTZ NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS demo_books_destination (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author_id TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      migrated_at TIMESTAMPTZ NOT NULL
    )
  `;

  yield* sql`
    INSERT INTO demo_authors_source ${sql.insert(
      fixture.sources.authors.map((author) => ({
        id: author.id,
        name: author.name,
        source_version: Number(author.source_version),
      }))
    )}
    ON CONFLICT (id) DO UPDATE SET
      name = excluded.name,
      source_version = excluded.source_version
  `;
  yield* sql`
    INSERT INTO demo_books_source ${sql.insert(
      fixture.sources.books.map((book) => ({
        author_id: book.author_id,
        id: book.id,
        source_version: Number(book.source_version),
        title: book.title,
      }))
    )}
    ON CONFLICT (id) DO UPDATE SET
      title = excluded.title,
      author_id = excluded.author_id,
      source_version = excluded.source_version
  `;
});

const installMigrationStoreSchema = Effect.gen(function* () {
  const plan = yield* SqlMigrationStore.planSchema({
    tablePrefix: migrationStoreTablePrefix,
  });

  if (plan.status !== "current") {
    yield* SqlMigrationStore.applySchemaPlan(plan);
  }
});

const demoDatabaseCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [authorRow] = yield* sql<{ readonly count: unknown }>`
    SELECT COUNT(*) AS count FROM demo_authors_source
  `;
  const [bookRow] = yield* sql<{ readonly count: unknown }>`
    SELECT COUNT(*) AS count FROM demo_books_source
  `;

  return {
    authors: readCount(authorRow?.count),
    books: readCount(bookRow?.count),
  } satisfies DemoDatabaseCounts;
});

export const setupDemoDatabase = (options: { readonly reset: boolean }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (options.reset) {
        yield* resetDemoDatabase;
      }

      yield* createAndSeedDemoTables;
      yield* installMigrationStoreSchema;

      return yield* demoDatabaseCounts;
    }).pipe(Effect.provide(PostgresLive))
  );

export const pingDemoDatabase = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
    }).pipe(Effect.provide(PostgresLive))
  );
