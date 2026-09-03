import { describe, expect, it } from "vitest";
import {
  bookCatalogImportProductCount,
  loadBookCatalogImportItems,
} from "./book-catalog-import-fixture.ts";

describe("book catalog Import API fixture", () => {
  it("maps every unique work in the shared catalog to one Product source item", async () => {
    const items = await loadBookCatalogImportItems({
      prefix: "live-books",
      productTypeKey: "live-book-type",
    });
    const keys = items.map((item) => item.identityKey);

    expect(items).toHaveLength(bookCatalogImportProductCount);
    expect(new Set(keys).size).toBe(items.length);
    expect(keys.every((key) => key.startsWith("live-books-q"))).toBe(true);
    expect(
      items.every((item) => item.item.productTypeKey === "live-book-type")
    ).toBe(true);
    expect(items.map((item) => item.item.name)).toContain("The Black Death");
  });
});
