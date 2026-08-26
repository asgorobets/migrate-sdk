import {
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import type { MigrationTuiActiveRun } from "../runtime.ts";
import {
  migrationTuiAvailableActions,
  migrationTuiPrimaryActions,
} from "./migration-actions.ts";

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-active");
const activeRun: MigrationTuiActiveRun = {
  definitionIds: [definitionId],
  execution: {
    adapter: "workflow-sdk",
    executionId: "workflow-active",
  },
  observationDefinitionId: definitionId,
  runId,
  startedAt: new Date("2026-08-25T12:00:00.000Z"),
  status: "running",
  stopSupported: true,
};

describe("migration actions", () => {
  it("offers run focus and stopping for a server-owned locked run", () => {
    const actions = migrationTuiAvailableActions(
      { definitionId, kind: "migration" },
      [
        {
          entry: {
            dependencies: { optional: [], required: [] },
            hasRollback: true,
            id: definitionId,
          },
          status: {
            definitionId,
            discovery: "full",
            durable: { failed: 0, migrated: 1, needsUpdate: 0, skipped: 0 },
            lastRun: null,
            lock: {
              createdAt: new Date("2026-08-25T12:00:00.000Z"),
              definitionId,
              ownerRunId: runId,
              token: toMigrationDefinitionLockToken("lock-active"),
            },
            warnings: [],
          },
        },
      ],
      [activeRun]
    );

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "view-run",
          key: "v",
          runId,
        }),
        expect.objectContaining({ id: "stop-run", key: "x", runId }),
        expect.objectContaining({ id: "break-lock" }),
      ])
    );
    expect(migrationTuiPrimaryActions(actions)).toEqual([
      expect.objectContaining({ id: "view-run" }),
      expect.objectContaining({ id: "stop-run" }),
    ]);
  });

  it("does not choose an arbitrary run when a group has multiple active runs", () => {
    const secondDefinitionId = toMigrationDefinitionId("authors");
    const secondRunId = toMigrationRunId("run-authors");
    const rows = [
      { definitionId, runId },
      { definitionId: secondDefinitionId, runId: secondRunId },
    ].map(({ definitionId: rowDefinitionId, runId: rowRunId }) => ({
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: rowDefinitionId,
      },
      status: {
        definitionId: rowDefinitionId,
        discovery: "full" as const,
        durable: { failed: 0, migrated: 1, needsUpdate: 0, skipped: 0 },
        lastRun: null,
        lock: {
          createdAt: new Date("2026-08-25T12:00:00.000Z"),
          definitionId: rowDefinitionId,
          ownerRunId: rowRunId,
          token: toMigrationDefinitionLockToken(`lock-${rowDefinitionId}`),
        },
        warnings: [],
      },
    }));
    const actions = migrationTuiAvailableActions(
      { groupId: toMigrationDefinitionGroupId("catalog"), kind: "group" },
      rows,
      [
        activeRun,
        {
          ...activeRun,
          definitionIds: [secondDefinitionId],
          observationDefinitionId: secondDefinitionId,
          execution: {
            adapter: "workflow-sdk",
            executionId: "workflow-authors",
          },
          runId: secondRunId,
        },
      ]
    );

    expect(actions).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "view-run" })])
    );
  });
});
