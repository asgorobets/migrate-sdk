import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  formatMigrationRunSummary,
  runInMemoryExample,
} from "./examples/in-memory-runtime.ts";

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
});
