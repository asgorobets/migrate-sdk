import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  formatMigrationRunSummary,
  runInMemoryExample,
} from "./examples/in-memory-runtime.ts";
import {
  formatNestedArticleSchemaExampleResult,
  runNestedArticleSchemaExample,
} from "./examples/nested-article-schema.ts";

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
});
