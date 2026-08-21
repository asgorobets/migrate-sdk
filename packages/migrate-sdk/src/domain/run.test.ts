import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import { toMigrationDefinitionId } from "./ids.ts";
import {
  type ExecutionStartResult,
  type MigrationDefinitionRunSummary,
  type MigrationRunHandle,
  makeRunRequest,
} from "./run.ts";

type AttachedStart = Extract<
  ExecutionStartResult,
  {
    readonly handle: MigrationRunHandle;
    readonly kind: "started";
  }
>;

type DetachedStart = Extract<
  ExecutionStartResult,
  {
    readonly handle?: undefined;
    readonly kind: "started";
  }
>;

describe("RunRequest", () => {
  it("preserves update intent for raw run requests", () => {
    const definitions = [] as const;

    expect(makeRunRequest({ definitions, update: true })).toEqual({
      definitions,
      update: true,
    });
  });

  it("preserves rescan intent for raw run requests", () => {
    const definitions = [] as const;

    expect(makeRunRequest({ definitions, rescan: true })).toEqual({
      definitions,
      rescan: true,
    });
  });

  it("normalizes rollback orphans to an authoritative rescan", () => {
    const definitions = [] as const;

    expect(
      makeRunRequest({
        definitions,
        rollbackOrphans: true,
      })
    ).toEqual({
      definitions,
      rollbackOrphans: true,
      rescan: true,
    });
  });
});

describe("ExecutionStartResult", () => {
  it("requires execution identity only for detached starts", () => {
    expectTypeOf<AttachedStart["execution"]["executionId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      DetachedStart["execution"]["executionId"]
    >().toEqualTypeOf<string>();
  });
});

describe("MigrationDefinitionRunSummary", () => {
  it("supports aggregate rollback-orphans counts", () => {
    const summary = {
      counts: {
        failed: 0,
        migrated: 0,
        needsUpdate: 0,
        orphaned: 3,
        rollbackFailed: 1,
        rolledBack: 2,
        skipped: 0,
        unchanged: 0,
      },
      definitionId: toMigrationDefinitionId("articles"),
      status: "failed",
    } satisfies MigrationDefinitionRunSummary;

    expect(summary.counts).toEqual(
      expect.objectContaining({
        orphaned: 3,
        rollbackFailed: 1,
        rolledBack: 2,
      })
    );
    expect(summary).not.toHaveProperty("sourceIdentities");
  });
});
