/** @effect-diagnostics nodeBuiltinImport:skip-file */
/** @effect-diagnostics processEnv:skip-file */
/** @effect-diagnostics globalConsole:skip-file */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { type CatalogBookRow, encodeCatalogCsv } from "./catalog-data.ts";

const fixtureDirectory = fileURLToPath(new URL(".", import.meta.url));
const dataDirectory =
  process.env.MIGRATE_SQLITE_CATALOG_DIR ?? join(fixtureDirectory, ".data");
const booksPath = join(dataDirectory, "sources", "books.csv");
const command = process.argv.slice(2).find((argument) => argument !== "--");

if (command !== "repair-failures" && command !== "publish-updates") {
  throw new Error("Mutation must be repair-failures or publish-updates");
}

const parsed = Papa.parse<CatalogBookRow>(await readFile(booksPath, "utf8"), {
  header: true,
  skipEmptyLines: true,
});
if (parsed.errors.length > 0) {
  throw new Error(`Unable to parse books CSV: ${parsed.errors[0]?.message}`);
}

let changed = 0;
const rows = parsed.data.map((row, index): CatalogBookRow => {
  if (
    command === "repair-failures" &&
    (row.disposition === "fail-reference" || row.disposition === "invalid")
  ) {
    changed += 1;
    return {
      ...row,
      author_id: row.canonical_author_id,
      disposition: "migrate",
      publication_year: row.canonical_publication_year,
      source_version: String(Number(row.source_version) + 1),
    };
  }

  if (
    command === "publish-updates" &&
    row.disposition === "migrate" &&
    (index + 1) % 211 === 0 &&
    !row.title.endsWith(" (revised)")
  ) {
    changed += 1;
    return {
      ...row,
      source_version: String(Number(row.source_version) + 1),
      title: `${row.title} (revised)`,
    };
  }

  return row;
});

await writeFile(booksPath, encodeCatalogCsv(rows));
console.log(`${command} changed ${changed} book rows`);
