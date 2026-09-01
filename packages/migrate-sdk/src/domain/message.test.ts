import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { expectTypeOf } from "vitest";
import {
  type MigrationItemErrorMessage,
  MigrationMessage,
  type MigrationProcessDiagnosticMessage,
} from "./message.ts";

const messageBase = {
  definitionId: "articles",
  message: "Author lookup failed",
  runId: "run-articles",
  severity: "error",
  sourceIdentity: "article-1",
  updatedAt: "2026-08-23T10:00:00.000Z",
} as const;

describe("MigrationMessage", () => {
  it("requires error metadata for item errors", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrationMessage)({
        ...messageBase,
        kind: "item-error",
      })
    ).toThrow();
  });

  it("requires a sequence for diagnostics", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrationMessage)({
        ...messageBase,
        kind: "process-diagnostic",
      })
    ).toThrow();
  });

  it("rejects error fields on reason messages", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrationMessage)({
        ...messageBase,
        errorKind: "process",
        errorTag: "ShouldNotSurvive",
        kind: "skip-reason",
        severity: "info",
      })
    ).toThrow();
  });

  it("rejects details with the wrong kind-specific shape", () => {
    expect(() =>
      Schema.decodeUnknownSync(MigrationMessage)({
        ...messageBase,
        details: ["diagnostics require a JSON object"],
        kind: "process-diagnostic",
        sequence: 0,
      })
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MigrationMessage)({
        ...messageBase,
        details: { reason: "reason messages do not carry details" },
        kind: "update-reason",
        severity: "warning",
      })
    ).toThrow();
  });

  it("exposes kind-specific fields after narrowing", () => {
    expectTypeOf<
      MigrationItemErrorMessage["errorTag"]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      MigrationProcessDiagnosticMessage["sequence"]
    >().toEqualTypeOf<number>();
  });
});
