import {
  type ActiveMigrationRun,
  toMigrationDefinitionGroupId,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import {
  migrationTuiAvailableActions,
  migrationTuiPrimaryActions,
} from "./migration-actions.ts";

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-active");
const activeRun: ActiveMigrationRun = {
  definitionIds: [definitionId],
  execution: {
    adapter: "workflow-sdk",
    executionId: "workflow-active",
  },
  observationDefinitionId: definitionId,
  runId,
  startedAt: new Date("2026-08-25T12:00:00.000Z"),
  status: "running",
};

describe("migration actions", () => {
  it("offers attachment as the primary action for a reconnectable locked run", () => {
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
          id: "attach-run",
          key: "a",
          runId,
        }),
        expect.objectContaining({ id: "break-lock" }),
      ])
    );
    expect(migrationTuiPrimaryActions(actions)).toEqual([
      expect.objectContaining({ id: "attach-run" }),
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
      expect.arrayContaining([expect.objectContaining({ id: "attach-run" })])
    );
  });
});
