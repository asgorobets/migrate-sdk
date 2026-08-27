/** @effect-diagnostics nodeBuiltinImport:skip-file */
/** @effect-diagnostics processEnv:skip-file */
/** @effect-diagnostics globalDate:skip-file */
/** @effect-diagnostics globalConsole:skip-file */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { encodeCatalogCsv, loadCatalogFixture } from "@fixtures/catalog";
import { Effect } from "effect";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";
import {
  markCatalogFixtureDirectory,
  prepareCatalogFixtureDirectory,
} from "./fixture-directory.ts";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const defaultDataDirectory = join(fixtureDirectory, ".data");
const tablePrefix = "catalog_demo";

const scaleRows = {
  default: 10_000,
  large: 50_000,
  small: 500,
} as const;

const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const scale = argumentValue("--scale") ?? "default";
if (!(scale in scaleRows)) {
  throw new Error("--scale must be small, default, or large");
}

const dataDirectory =
  process.env.MIGRATE_SQLITE_CATALOG_DIR ?? defaultDataDirectory;
const shouldReset = process.argv.includes("--reset");

await prepareCatalogFixtureDirectory(dataDirectory, shouldReset);

const sourceDirectory = join(dataDirectory, "sources");
await mkdir(sourceDirectory, { recursive: true });
await markCatalogFixtureDirectory(dataDirectory);

const { seedCount, snapshot, sources } = await loadCatalogFixture({
  bookCount: scaleRows[scale as keyof typeof scaleRows],
});

await Promise.all([
  writeFile(
    join(sourceDirectory, "authors.csv"),
    encodeCatalogCsv(sources.authors)
  ),
  writeFile(
    join(sourceDirectory, "books.csv"),
    encodeCatalogCsv(sources.books)
  ),
  writeFile(
    join(sourceDirectory, "publishers.csv"),
    encodeCatalogCsv(sources.publishers)
  ),
  writeFile(
    join(sourceDirectory, "subjects.csv"),
    encodeCatalogCsv(sources.subjects)
  ),
]);

const destinationPath = join(dataDirectory, "destination.sqlite");
const destination = new DatabaseSync(destinationPath);
destination.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE catalog_authors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE catalog_publishers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE catalog_subjects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE catalog_books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author_id TEXT NOT NULL REFERENCES catalog_authors(id),
    publisher_id TEXT NOT NULL REFERENCES catalog_publishers(id),
    subject_id TEXT REFERENCES catalog_subjects(id),
    publication_year INTEGER NOT NULL,
    isbn TEXT NOT NULL,
    wikidata_work_id TEXT NOT NULL
  );
`);
destination.close();

const statePath = join(dataDirectory, "state.sqlite");
const stateLayer = SqliteClient.layer({ filename: statePath });
await Effect.runPromise(
  Effect.gen(function* () {
    const plan = yield* SqlMigrationStore.planSchema({ tablePrefix });
    if (plan.status !== "current") {
      yield* SqlMigrationStore.applySchemaPlan(plan);
    }
  }).pipe(Effect.provide(stateLayer))
);

const manifest = {
  bookRows: sources.books.length,
  counts: sources.counts,
  generatedAt: new Date().toISOString(),
  scale,
  seedRows: seedCount,
  snapshotSha256: createHash("sha256").update(snapshot).digest("hex"),
  source: "https://query.wikidata.org/sparql",
  sourceLicense: "CC0-1.0",
};
await writeFile(
  join(dataDirectory, "fixture-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);

console.log(`SQLite catalog fixture ready at ${dataDirectory}`);
console.log(
  `${sources.books.length} books: ${sources.counts.migrated} migrate, ${sources.counts.skipped} skip, ${sources.counts.failedReferences + sources.counts.invalid} fail`
);
