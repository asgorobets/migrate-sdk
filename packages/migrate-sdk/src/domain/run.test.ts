import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { expectTypeOf } from "vitest";
import { toMigrationDefinitionId, toMigrationRunId } from "./ids.ts";
import {
  ActiveMigrationRun,
  type ExecutionStartResult,
  type MigrationDefinitionRunSummary,
  type MigrationRunHandle,
  makeMigrationDefinitionRunState,
  makeMigrationRunState,
  makeRunRequest,
} from "./run.ts";

describe("ActiveMigrationRun", () => {
  it("rejects an observation definition outside the run", () => {
    expect(() =>
      Schema.decodeUnknownSync(ActiveMigrationRun)({
        definitionIds: [toMigrationDefinitionId("articles")],
        observationDefinitionId: toMigrationDefinitionId("authors"),
        runId: toMigrationRunId("run-1"),
        startedAt: new Date("2026-08-25T12:00:00.000Z"),
        status: "running",
      })
    ).toThrow();
  });
});

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

describe("MigrationDefinitionRunState", () => {
  it("preserves the aggregate run status alongside one definition outcome", () => {
    const runState = {
      definitionIds: [
        toMigrationDefinitionId("authors"),
        toMigrationDefinitionId("articles"),
      ],
      finishedAt: new Date("2026-01-01T00:01:00.000Z"),
      runId: toMigrationRunId("run-1"),
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      status: "failed" as const,
    };

    const definitionRunState = makeMigrationDefinitionRunState(
      toMigrationDefinitionId("authors"),
      runState,
      "succeeded"
    );

    expect(definitionRunState).toEqual({
      ...runState,
      definitionId: toMigrationDefinitionId("authors"),
      runStatus: "failed",
      status: "succeeded",
    });
    expect(makeMigrationRunState(definitionRunState)).toEqual(runState);
  });
});
