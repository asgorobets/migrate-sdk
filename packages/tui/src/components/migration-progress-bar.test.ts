import { describe, expect, it } from "vitest";
import {
  aggregateSourceItemTotals,
  migrationProgressBarModel,
} from "./migration-progress-bar.ts";

const counts = {
  failed: 0,
  migrated: 1,
  needsUpdate: 0,
  skipped: 0,
};

describe("migration progress bar", () => {
  it("keeps the unprocessed source total as empty bar space", () => {
    expect(
      migrationProgressBarModel(counts, { count: 4, kind: "known" })
    ).toEqual({
      label: "1 / 4 · 25%",
      remaining: 3,
      segments: [{ count: 1, kind: "migrated" }],
    });
  });

  it("does not stretch counts to a complete bar without a known total", () => {
    expect(migrationProgressBarModel(counts, undefined)).toEqual({
      label: "1 processed",
      remaining: 1,
      segments: [],
    });
  });

  it("separates tracked state outside the current source from percentage progress", () => {
    expect(
      migrationProgressBarModel(
        { ...counts, failed: 1, migrated: 4 },
        { count: 4, kind: "known" }
      )
    ).toEqual({
      label: "5 tracked · 4 source · +1 outside source",
      remaining: 0,
      segments: [
        { count: 4, kind: "migrated" },
        { count: 1, kind: "failed" },
      ],
    });
  });

  it("composes the full migration state against the source total", () => {
    expect(
      migrationProgressBarModel(
        { failed: 1, migrated: 2, needsUpdate: 1, skipped: 1 },
        { count: 10, kind: "known" }
      )
    ).toEqual({
      label: "5 / 10 · 50%",
      remaining: 5,
      segments: [
        { count: 2, kind: "migrated" },
        { count: 1, kind: "failed" },
        { count: 1, kind: "skipped" },
        { count: 1, kind: "needs-update" },
      ],
    });
  });

  it("aggregates known and capped group totals as a lower bound", () => {
    expect(
      aggregateSourceItemTotals([
        { count: 3, kind: "known" },
        { kind: "lower-bound", minimum: 10_000, reason: "capped" },
      ])
    ).toEqual({ kind: "lower-bound", minimum: 10_003, reason: "capped" });
  });

  it("does not claim a group total when a definition total is unknown", () => {
    expect(
      aggregateSourceItemTotals([
        { count: 3, kind: "known" },
        { kind: "unknown", reason: "unsupported" },
      ])
    ).toBeUndefined();
  });
});
