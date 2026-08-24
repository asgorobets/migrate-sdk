import {
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import type { MigrationTuiMessage } from "../runtime.ts";
import {
  migrationMessageMarker,
  migrationMessageRowKey,
} from "./migration-message.ts";

const diagnostic = (
  sequence: number,
  runId = "run-articles"
): MigrationTuiMessage => ({
  definitionId: toMigrationDefinitionId("articles"),
  kind: "process-diagnostic",
  message: "Author lookup failed",
  runId: toMigrationRunId(runId),
  sequence,
  severity: "error",
  sourceIdentity: toEncodedSourceIdentity("article-1"),
  updatedAt: new Date("2026-08-23T10:00:00.000Z"),
});

describe("migrationMessageRowKey", () => {
  it("distinguishes repeated diagnostics by sequence", () => {
    expect(migrationMessageRowKey(diagnostic(0))).not.toBe(
      migrationMessageRowKey(diagnostic(1))
    );
  });

  it("distinguishes repeated diagnostics by run", () => {
    expect(migrationMessageRowKey(diagnostic(0))).not.toBe(
      migrationMessageRowKey(diagnostic(0, "run-articles-retry"))
    );
  });
});

describe("migrationMessageMarker", () => {
  it("uses one marker policy for every message surface", () => {
    expect(migrationMessageMarker("error")).toBe("✗");
    expect(migrationMessageMarker("warning")).toBe("!");
    expect(migrationMessageMarker("info")).toBe("•");
  });
});
