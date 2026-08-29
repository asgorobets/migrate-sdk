import { describe, expect, it } from "vitest";
import catalogFixtureSnapshot from "../../../../fixtures/catalog/books.csv?raw";
import { loadCatalogFixtureFromSnapshot } from "../../../../fixtures/catalog/fixture";

describe("workflow demo catalog fixture", () => {
  it("loads the checked-in CSV through the server bundle", () => {
    const fixture = loadCatalogFixtureFromSnapshot(catalogFixtureSnapshot, {
      bookCount: 240,
      outcomes: "all-migrate",
    });

    expect(fixture.snapshot).toBe(catalogFixtureSnapshot);
    expect(fixture.sources.authors.length).toBeGreaterThan(0);
    expect(fixture.sources.books).toHaveLength(240);
  });
});
