import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  formatCircularBookAuthorStubsExampleResult,
  runCircularBookAuthorStubsExample,
} from "./circular-book-author-stubs.ts";
import {
  formatMigrationRunSummary,
  runInMemoryExample,
} from "./in-memory-runtime.ts";
import {
  formatNestedArticleSchemaExampleResult,
  runNestedArticleSchemaExample,
} from "./nested-article-schema.ts";

describe("in-memory runtime example", () => {
  it.effect("runs a complete Migration Run without external systems", () =>
    Effect.gen(function* () {
      const summary = yield* runInMemoryExample();
      const output = formatMigrationRunSummary(summary);

      expect(summary.status).toBe("succeeded");
      expect(summary.definitions).toHaveLength(1);
      expect(summary.definitions[0]?.definitionId).toBe("articles");
      expect(summary.definitions[0]?.counts).toEqual({
        migrated: 2,
        skipped: 1,
        failed: 0,
        unchanged: 0,
        needsUpdate: 0,
      });
      expect(output).toContain("Migration Run Summary");
      expect(output).toContain("status: succeeded");
      expect(output).toContain("articles");
    })
  );

  it.effect(
    "runs a nested article Source Payload Schema example with typed pipeline fields",
    () =>
      Effect.gen(function* () {
        const result = yield* runNestedArticleSchemaExample();
        const output = formatNestedArticleSchemaExampleResult(result);

        expect(result.summary.status).toBe("succeeded");
        expect(result.commandFields).toEqual([
          {
            authorDisplayName: "Ada Lovelace",
            locale: "en-US",
            readingTimeMinutes: 7,
            seoDescription: "A realistic source payload with nested fields",
            seoTitle: "Schema-first migrations",
            slug: "schema-first-migrations",
            tagLabels: ["Effect", "Schemas"],
            title: "Schema-first migrations",
            views: 1280,
          },
        ]);
        expect(output).toContain("Nested Article Source Schema Example");
        expect(output).toContain("author: Ada Lovelace");
        expect(output).toContain("tags: Effect, Schemas");
      })
  );

  it.effect(
    "runs a circular Book and Author migration through lookup-created stubs",
    () =>
      Effect.gen(function* () {
        const result = yield* runCircularBookAuthorStubsExample();
        const output = formatCircularBookAuthorStubsExampleResult(result);

        expect(result.summary.status).toBe("succeeded");
        expect(
          result.summary.definitions.map(
            (definition) => definition.definitionId
          )
        ).toEqual(["books", "authors"]);
        expect(result.summary.definitions[0]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(result.summary.definitions[1]?.counts).toEqual({
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        });
        expect(result.bookEntryFields?.authorEntries).toEqual([
          "entry:author:author:maya-chen",
        ]);
        expect(result.bookEntryFields?.authorReferenceStatuses).toEqual([
          "needs-update",
        ]);
        expect(result.authorEntryFields?.popularBookEntries).toEqual([
          "entry:book:book:effectful-architecture",
          "entry:book:book:future-catalog",
        ]);
        expect(result.authorEntryFields?.popularBookReferenceStatuses).toEqual([
          "migrated",
          "needs-update",
        ]);
        expect(result.bookStubState).toEqual(
          expect.objectContaining({
            definitionId: "books",
            sourceIdentity: "book:future-catalog",
            status: "needs-update",
            destinationIdentity: "entry:book:book:future-catalog",
          })
        );
        expect(result.authorState).toEqual(
          expect.objectContaining({
            definitionId: "authors",
            sourceIdentity: "author:maya-chen",
            sourceVersion: "author-version-1",
            status: "migrated",
            destinationIdentity: "entry:author:author:maya-chen",
          })
        );
        expect(output).toContain("Circular Book and Author Stub Example");
        expect(output).toContain("future book stub status: needs-update");
        expect(output).toContain("author final status: migrated");
      })
  );
});
