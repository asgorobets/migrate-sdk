import { describe, expect, it } from "@effect/vitest";
import {
  normalizeMigrationExecutionOptions,
  normalizePipelineExecutionOptions,
  resolvePipelineExecutionOptions,
} from "./execution.ts";

describe("migration execution options", () => {
  it("uses serial pipeline execution by default", () => {
    expect(
      resolvePipelineExecutionOptions(
        undefined,
        undefined,
        "Process Pipeline Execution"
      )
    ).toEqual({ concurrency: 1 });
  });

  it("keeps process and rollback options independent", () => {
    expect(
      normalizeMigrationExecutionOptions({
        process: { concurrency: 2 },
      })
    ).toEqual({
      process: { concurrency: 2 },
    });
  });

  it("prefers request concurrency over definition defaults", () => {
    expect(
      resolvePipelineExecutionOptions(
        { concurrency: "unbounded" },
        { concurrency: 2 },
        "Process Pipeline Execution"
      )
    ).toEqual({ concurrency: "unbounded" });
  });

  it("uses definition concurrency when no request override is supplied", () => {
    expect(
      resolvePipelineExecutionOptions(
        undefined,
        { concurrency: 3 },
        "Rollback Pipeline Execution"
      )
    ).toEqual({ concurrency: 3 });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    "many" as never,
  ])("rejects invalid pipeline concurrency %s", (concurrency) => {
    expect(() =>
      normalizePipelineExecutionOptions(
        { concurrency },
        "Process Pipeline Execution"
      )
    ).toThrow(
      'Process Pipeline Execution concurrency must be a positive integer or "unbounded"'
    );
  });
});
