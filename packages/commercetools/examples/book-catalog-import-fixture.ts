import { readFile } from "node:fs/promises";
import type { SourceItemInput } from "migrate-sdk";
import Papa from "papaparse";
import type { CatalogProductImportSource } from "./product-import-batch-migration.ts";

interface WikidataBookCsvRow {
  readonly isbn: string;
  readonly publicationDate: string;
  readonly work: string;
  readonly workLabel: string;
}

const catalogFixtureUrl = new URL(
  "../../../fixtures/catalog/books.csv",
  import.meta.url
);

export const bookCatalogImportProductCount = 79;

const wikidataEntityId = (uri: string): string =>
  uri.slice(uri.lastIndexOf("/") + 1);

export const loadBookCatalogImportItems = async (options: {
  readonly prefix: string;
  readonly productTypeKey: string;
}): Promise<readonly SourceItemInput<CatalogProductImportSource, string>[]> => {
  const snapshot = await readFile(catalogFixtureUrl, "utf8");
  const parsed = Papa.parse<WikidataBookCsvRow>(snapshot, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new Error(
      `Unable to parse the shared book catalog: ${parsed.errors[0]?.message}`
    );
  }

  const booksByWorkId = new Map<string, WikidataBookCsvRow>();

  for (const row of parsed.data) {
    const workId = wikidataEntityId(row.work).trim();

    if (
      workId.length > 0 &&
      row.workLabel.trim().length > 0 &&
      !booksByWorkId.has(workId)
    ) {
      booksByWorkId.set(workId, row);
    }
  }

  return [...booksByWorkId].map(([workId, row], index) => {
    const key = `${options.prefix}-${workId.toLowerCase()}`;

    return {
      identityKey: key,
      item: {
        format: index % 2 === 0 ? "paperback" : "hardcover",
        isbn: row.isbn.trim() || `wikidata-${workId}`,
        key,
        name:
          row.workLabel === workId ? `Wikidata work ${workId}` : row.workLabel,
        pages: 160 + index,
        productTypeKey: options.productTypeKey,
        sku: `${key}-sku`,
        slug: key,
      },
      version: row.publicationDate || "catalog-snapshot-1",
    };
  });
};
