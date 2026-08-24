import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  buildCatalogFixtureSources,
  CatalogBookSourceRow,
  parseWikidataBookSeeds,
} from "./catalog-data.ts";

const snapshot = `work,workLabel,author,authorLabel,publisher,publisherLabel,publicationDate,isbn
http://www.wikidata.org/entity/Q1,Book One,http://www.wikidata.org/entity/Q2,Author One,http://www.wikidata.org/entity/Q3,Publisher One,2001-01-01T00:00:00Z,978-1
http://www.wikidata.org/entity/Q1,Book One,http://www.wikidata.org/entity/Q4,Author Two,http://www.wikidata.org/entity/Q3,Publisher One,2001-01-01T00:00:00Z,978-1
http://www.wikidata.org/entity/Q5,Q5,http://www.wikidata.org/entity/Q6,Author Three,http://www.wikidata.org/entity/Q7,Publisher Two,,
`;

describe("SQLite catalog fixture data", () => {
  it("normalizes a Wikidata CSV snapshot into one seed per work", () => {
    expect(parseWikidataBookSeeds(snapshot)).toEqual([
      {
        authorId: "Q2",
        authorName: "Author One",
        isbn: "978-1",
        publicationYear: 2001,
        publisherId: "Q3",
        publisherName: "Publisher One",
        title: "Book One",
        workId: "Q1",
      },
      {
        authorId: "Q6",
        authorName: "Author Three",
        isbn: "",
        publicationYear: 2000,
        publisherId: "Q7",
        publisherName: "Publisher Two",
        title: "Wikidata work Q5",
        workId: "Q5",
      },
    ]);
  });

  it("amplifies real seeds with deterministic and exclusive outcomes", () => {
    const sources = buildCatalogFixtureSources(
      parseWikidataBookSeeds(snapshot),
      262
    );

    expect(sources.books).toHaveLength(262);
    expect(sources.counts).toEqual({
      failedReferences: 2,
      invalid: 2,
      migrated: 252,
      skipped: 6,
    });
    expect(sources.books[40]?.disposition).toBe("skip");
    expect(sources.books[96]).toEqual(
      expect.objectContaining({
        author_id: "missing-author-00097",
        disposition: "fail-reference",
      })
    );
    expect(sources.books[130]).toEqual(
      expect.objectContaining({
        disposition: "invalid",
        publication_year: "3026",
      })
    );
  });

  it("rejects unknown book dispositions", () => {
    expect(() =>
      Schema.decodeUnknownSync(CatalogBookSourceRow)({
        author_id: "Q2",
        canonical_author_id: "Q2",
        canonical_publication_year: "2001",
        disposition: "unexpected",
        id: "Q1-edition-0001",
        isbn: "978-1",
        publication_year: "2001",
        publisher_id: "Q3",
        source_version: "1",
        subject_id: "subject-01",
        title: "Book One",
        wikidata_work_id: "Q1",
      })
    ).toThrow();
  });
});
