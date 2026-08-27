/** @effect-diagnostics nodeBuiltinImport:skip-file */
import { readFile } from "node:fs/promises";
import Papa from "papaparse";

/**
 * Deterministic example data expanded from a checked-in Wikidata CC0 snapshot.
 * Source: https://www.wikidata.org/wiki/Wikidata:Licensing
 */

export type CatalogBookDisposition =
  | "fail-reference"
  | "invalid"
  | "migrate"
  | "skip";

export interface WikidataBookSeed {
  readonly authorId: string;
  readonly authorName: string;
  readonly isbn: string;
  readonly publicationYear: number;
  readonly publisherId: string;
  readonly publisherName: string;
  readonly title: string;
  readonly workId: string;
}

export interface CatalogEntityRow {
  readonly id: string;
  readonly name: string;
  readonly source_version: string;
}

export interface CatalogBookRow {
  readonly author_id: string;
  readonly canonical_author_id: string;
  readonly canonical_publication_year: string;
  readonly disposition: CatalogBookDisposition;
  readonly id: string;
  readonly isbn: string;
  readonly publication_year: string;
  readonly publisher_id: string;
  readonly source_version: string;
  readonly subject_id: string;
  readonly title: string;
  readonly wikidata_work_id: string;
}

interface WikidataCsvRow {
  readonly author: string;
  readonly authorLabel: string;
  readonly isbn: string;
  readonly publicationDate: string;
  readonly publisher: string;
  readonly publisherLabel: string;
  readonly work: string;
  readonly workLabel: string;
}

export interface CatalogFixtureSources {
  readonly authors: readonly CatalogEntityRow[];
  readonly books: readonly CatalogBookRow[];
  readonly counts: {
    readonly failedReferences: number;
    readonly invalid: number;
    readonly migrated: number;
    readonly skipped: number;
  };
  readonly publishers: readonly CatalogEntityRow[];
  readonly subjects: readonly CatalogEntityRow[];
}

export interface CatalogFixtureOptions {
  readonly outcomes?: "all-migrate" | "mixed";
}

const subjectNames = [
  "Architecture",
  "Arts",
  "Biography",
  "Business",
  "Culture",
  "Education",
  "History",
  "Literature",
  "Philosophy",
  "Politics",
  "Science",
  "Technology",
] as const;

const entityId = (uri: string): string => uri.slice(uri.lastIndexOf("/") + 1);

const publicationYear = (value: string): number => {
  const year = Number.parseInt(value.slice(0, 4), 10);
  return Number.isSafeInteger(year) && year > 0 ? year : 2000;
};

export const parseWikidataBookSeeds = (
  input: string
): readonly WikidataBookSeed[] => {
  const result = Papa.parse<WikidataCsvRow>(input, {
    header: true,
    skipEmptyLines: true,
  });

  if (result.errors.length > 0) {
    throw new Error(
      `Unable to parse Wikidata CSV: ${result.errors[0]?.message}`
    );
  }

  const seeds = new Map<string, WikidataBookSeed>();

  for (const row of result.data) {
    const workId = entityId(row.work);
    const authorId = entityId(row.author);
    const publisherId = entityId(row.publisher);

    if (
      workId.length === 0 ||
      authorId.length === 0 ||
      publisherId.length === 0 ||
      row.workLabel.length === 0 ||
      row.authorLabel.length === 0 ||
      row.publisherLabel.length === 0 ||
      seeds.has(workId)
    ) {
      continue;
    }

    seeds.set(workId, {
      authorId,
      authorName: row.authorLabel,
      isbn: row.isbn,
      publicationYear: publicationYear(row.publicationDate),
      publisherId,
      publisherName: row.publisherLabel,
      title:
        row.workLabel === workId ? `Wikidata work ${workId}` : row.workLabel,
      workId,
    });
  }

  if (seeds.size === 0) {
    throw new Error("Wikidata CSV did not contain any complete book records");
  }

  return [...seeds.values()];
};

const uniqueEntities = (
  values: readonly { readonly id: string; readonly name: string }[]
): readonly CatalogEntityRow[] =>
  [...new Map(values.map((value) => [value.id, value] as const)).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((value) => ({ ...value, source_version: "1" }));

export const buildCatalogFixtureSources = (
  seeds: readonly WikidataBookSeed[],
  bookCount: number,
  options: CatalogFixtureOptions = {}
): CatalogFixtureSources => {
  if (!Number.isSafeInteger(bookCount) || bookCount <= 0) {
    throw new Error("Catalog book count must be a positive integer");
  }
  if (seeds.length === 0) {
    throw new Error("At least one Wikidata book seed is required");
  }

  const authors = uniqueEntities(
    seeds.map((seed) => ({ id: seed.authorId, name: seed.authorName }))
  );
  const publishers = uniqueEntities(
    seeds.map((seed) => ({ id: seed.publisherId, name: seed.publisherName }))
  );
  const subjects = subjectNames.map((name, index) => ({
    id: `subject-${String(index + 1).padStart(2, "0")}`,
    name,
    source_version: "1",
  }));
  const fallbackSubject = subjects[0];
  if (fallbackSubject === undefined) {
    throw new Error("Catalog fixture requires at least one subject");
  }
  const books: CatalogBookRow[] = [];
  const counts = {
    failedReferences: 0,
    invalid: 0,
    migrated: 0,
    skipped: 0,
  };
  const outcomes = options.outcomes ?? "mixed";

  for (let index = 1; index <= bookCount; index += 1) {
    const seed = seeds[(index - 1) % seeds.length];
    if (seed === undefined) {
      throw new Error("Catalog seed selection failed");
    }

    const edition = Math.floor((index - 1) / seeds.length) + 1;
    let disposition: CatalogBookRow["disposition"] = "migrate";
    if (outcomes === "mixed") {
      if (index % 97 === 0) {
        disposition = "fail-reference";
      } else if (index % 131 === 0) {
        disposition = "invalid";
      } else if (index % 41 === 0) {
        disposition = "skip";
      }
    }

    if (disposition === "fail-reference") {
      counts.failedReferences += 1;
    } else if (disposition === "invalid") {
      counts.invalid += 1;
    } else if (disposition === "skip") {
      counts.skipped += 1;
    } else {
      counts.migrated += 1;
    }

    books.push({
      author_id:
        disposition === "fail-reference"
          ? `missing-author-${String(index).padStart(5, "0")}`
          : seed.authorId,
      canonical_author_id: seed.authorId,
      canonical_publication_year: String(seed.publicationYear),
      disposition,
      id: `${seed.workId}-edition-${String(edition).padStart(4, "0")}`,
      isbn: seed.isbn || `demo-isbn-${String(index).padStart(8, "0")}`,
      publication_year:
        disposition === "invalid" ? "3026" : String(seed.publicationYear),
      publisher_id: seed.publisherId,
      source_version: "1",
      subject_id:
        subjects[(index - 1) % subjects.length]?.id ?? fallbackSubject.id,
      title:
        edition === 1 ? seed.title : `${seed.title} — demo edition ${edition}`,
      wikidata_work_id: seed.workId,
    });
  }

  return { authors, books, counts, publishers, subjects };
};

export const encodeCatalogCsv = (rows: readonly object[]): string =>
  `${Papa.unparse([...rows], { newline: "\n" })}\n`;

export interface LoadCatalogFixtureOptions extends CatalogFixtureOptions {
  readonly bookCount: number;
}

export interface LoadedCatalogFixture {
  readonly seedCount: number;
  readonly snapshot: string;
  readonly sources: CatalogFixtureSources;
}

export const loadCatalogFixture = (
  options: LoadCatalogFixtureOptions
): Promise<LoadedCatalogFixture> =>
  readFile(new URL("./books.csv", import.meta.url), "utf8").then((snapshot) => {
    const seeds = parseWikidataBookSeeds(snapshot);

    return {
      seedCount: seeds.length,
      snapshot,
      sources: buildCatalogFixtureSources(seeds, options.bookCount, options),
    };
  });
