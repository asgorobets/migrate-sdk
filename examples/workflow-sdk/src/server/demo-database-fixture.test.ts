import { describe, expect, it } from "vitest";
import catalogFixtureSnapshot from "../../../../fixtures/catalog/books.csv?raw";
import { loadCatalogFixtureFromSnapshot } from "../../../../fixtures/catalog/fixture";

describe("workflow demo catalog fixture", () => {
  it("loads the checked-in CSV through the server bundle", () => {
    const fixture = loadCatalogFixtureFromSnapshot(catalogFixtureSnapshot, {
      bookCount: 240,
      outcomes: "mixed",
    });

    expect(fixture.snapshot).toBe(catalogFixtureSnapshot);
    expect(fixture.sources.authors.length).toBeGreaterThan(0);
    expect(fixture.sources.books).toHaveLength(240);
    expect(fixture.sources.counts).toEqual({
      failedReferences: 2,
      invalid: 1,
      migrated: 232,
      skipped: 5,
    });
  });
});
