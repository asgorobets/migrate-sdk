import { describe, expect, it } from "vitest";
import {
  remoteMigrateDashboard as dashboard,
  remoteMigrateDefinitionId as definitionId,
  remoteMigrateRunId as runId,
} from "../../../test/fixtures/remote-server.ts";
import {
  type MigrationItemProgress,
  makeMigrationItemProgress,
} from "../../domain/item-progress.ts";
import { MigrateDashboardResumeToken } from "../../protocol/index.ts";
import { makeDashboardProjection } from "./progress-projection.ts";

const definitions = dashboard.rows.flatMap((row) =>
  row.status === undefined
    ? []
    : [
        {
          ...row.status,
          durable: { migrated: 1000, failed: 10, skipped: 0, needsUpdate: 0 },
        },
      ]
);
const definition = definitions[0];
if (definition === undefined) {
  throw new Error("Missing test definition");
}
const baseline: MigrationItemProgress = {
  kind: "baseline",
  runId,
  definitions,
};
const snapshot = (
  partitionId: string,
  revision: number,
  migrated: number,
  failed = 0
): MigrationItemProgress => ({
  kind: "snapshot",
  runId,
  partitionId,
  revision,
  changes: [
    { definitionId, delta: { migrated, failed, skipped: 0, needsUpdate: 0 } },
  ],
});

describe("client progress projection", () => {
  it("combines independent windows, replaces revisions, ignores replay and isolates attempts", () => {
    const projection = makeMigrationItemProgress();
    projection.apply(baseline);
    projection.apply(snapshot("a:1", 1, 12, -2));
    expect(projection.apply(snapshot("b:1", 1, 8))[0]?.durable).toMatchObject({
      migrated: 1020,
      failed: 8,
    });
    projection.apply(snapshot("a:1", 2, 15, -3));
    projection.apply(snapshot("a:1", 1, 12, -2));
    expect(projection.apply(snapshot("b:1", 1, 8))[0]?.durable).toMatchObject({
      migrated: 1023,
      failed: 7,
    });
    // A retry contributes only writes made by that attempt. A rollback removes
    // stored states; neither transition is an increment-only outcome count.
    expect(projection.apply(snapshot("a:2", 1, -4))[0]?.durable.migrated).toBe(
      1019
    );
    expect(projection.apply(baseline)[0]?.durable.migrated).toBe(1019);
  });

  it("retains projection and cursor over server replacement, buffers replay and reconciles lost worker updates", () => {
    const projection = makeDashboardProjection();
    const resumeToken = MigrateDashboardResumeToken.make("snapshot");
    projection.apply({ dashboard, resumeToken });
    const partial = {
      ...dashboard,
      rows: dashboard.rows.map(({ entry }) => ({ entry })),
    };
    const update = (
      progress: MigrationItemProgress,
      cursor: string,
      replaying: boolean
    ) =>
      projection.apply({
        dashboard: partial,
        resumeToken,
        partial: true,
        progress: { kind: "progress", runId, progress, cursor, replaying },
      });
    expect(
      update(baseline, "0", true).dashboard.rows[0]?.status?.durable.migrated
    ).toBe(12);
    expect(
      update(snapshot("a:1", 1, 12), "1", false).dashboard.rows[0]?.status
        ?.durable.migrated
    ).toBe(1012);
    expect(projection.resume()).toEqual([
      { runId, observationDefinitionId: definitionId, cursor: "1" },
    ]);
    projection.apply({ dashboard: partial, resumeToken, partial: true });
    expect(
      update(snapshot("a:1", 2, 15), "2", false).dashboard.rows[0]?.status
        ?.durable.migrated
    ).toBe(1015);
    const reconciled = projection.apply({
      dashboard: {
        ...dashboard,
        activeRuns: [],
        rows: dashboard.rows.map((row) => ({
          ...row,
          status: {
            ...definition,
            durable: { migrated: 1020, failed: 10, skipped: 0, needsUpdate: 0 },
          },
        })),
      },
      resumeToken,
      partial: true,
    });
    expect(reconciled.dashboard.rows[0]?.status?.durable.migrated).toBe(1020);
    expect(projection.resume()).toEqual([]);
  });
  it("keeps lifecycle metadata when later item snapshots arrive and warns once if the baseline is missing", () => {
    const projection = makeDashboardProjection();
    const resumeToken = MigrateDashboardResumeToken.make("snapshot");
    projection.apply({ dashboard, resumeToken });
    const partial = {
      ...dashboard,
      rows: dashboard.rows.map(({ entry }) => ({ entry })),
    };
    const incomplete = projection.apply({
      dashboard: partial,
      resumeToken,
      partial: true,
      progress: {
        kind: "progress",
        runId,
        progress: snapshot("a:1", 1, 2),
      },
    });
    expect(incomplete.observationWarning).toContain("totals will reconcile");
    expect(incomplete.dashboard.rows[0]?.status?.durable.migrated).toBe(12);
    const completion = {
      definitionId,
      runId,
      completedAt: new Date("2026-09-18T12:00:00Z"),
      sourceCursor: null,
    };
    projection.apply({
      dashboard: partial,
      resumeToken,
      partial: true,
      progress: { kind: "progress", runId, progress: baseline },
      metadata: [{ definitionId, completion, lastRun: null, lock: null }],
    });
    const next = projection.apply({
      dashboard: partial,
      resumeToken,
      partial: true,
      progress: {
        kind: "progress",
        runId,
        progress: snapshot("a:1", 2, 4),
      },
    });
    expect(next.dashboard.rows[0]?.status?.completion).toEqual(completion);
    expect(next.dashboard.rows[0]?.status?.durable.migrated).toBe(1004);
    expect(next.observationWarning).toBeUndefined();
  });
});
