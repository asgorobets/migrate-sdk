import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toMigrationDefinitionId, toMigrationRunId } from "migrate-sdk";
import type {
  MigrateActiveRun,
  MigrateDashboardRow,
} from "migrate-sdk/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSessionActivity,
  defaultSessionActivityExportPath,
  emptySessionActivity,
  exportSessionActivity,
  observedRunActivity,
  sessionActivityJsonLines,
} from "./session-activity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("Session Activity", () => {
  const definitionId = toMigrationDefinitionId("catalog");
  const runId = toMigrationRunId("run-catalog");
  const startedAt = new Date("2026-08-29T12:00:00.000Z");
  const activeRun = {
    definitionIds: [definitionId],
    observationDefinitionId: definitionId,
    runId,
    startedAt,
    status: "running",
    stopSupported: true,
  } satisfies MigrateActiveRun;

  it("records active-run discovery, transitions, and durable completion", () => {
    expect(
      observedRunActivity(undefined, { activeRuns: [activeRun], rows: [] })
    ).toEqual([
      {
        kind: "status",
        message: `Run ${runId} running · ${definitionId}`,
      },
    ]);

    const cancellingRun = {
      ...activeRun,
      status: "cancelling" as const,
    };
    expect(
      observedRunActivity(
        { activeRuns: [activeRun], rows: [] },
        { activeRuns: [cancellingRun], rows: [] }
      )
    ).toEqual([
      {
        kind: "warning",
        message: `Run ${runId} stopping · ${definitionId}`,
      },
    ]);

    const failedRow = {
      entry: {
        dependencies: { optional: [], required: [] },
        hasRollback: true,
        id: definitionId,
      },
      status: {
        definitionId,
        discovery: "incremental",
        durable: {
          failed: 1,
          migrated: 0,
          needsUpdate: 0,
          skipped: 0,
        },
        lastRun: {
          definitionId,
          definitionIds: [definitionId],
          finishedAt: new Date("2026-08-29T12:00:05.000Z"),
          runId,
          runStatus: "failed",
          startedAt,
          status: "failed",
        },
        lock: null,
        warnings: [],
      },
    } satisfies MigrateDashboardRow;

    expect(
      observedRunActivity(
        { activeRuns: [cancellingRun], rows: [] },
        { activeRuns: [], rows: [failedRow] }
      )
    ).toEqual([
      {
        kind: "error",
        message: `Run ${runId} failed · ${definitionId}`,
      },
    ]);

    expect(
      observedRunActivity(
        { activeRuns: [], rows: [] },
        { activeRuns: [], rows: [failedRow] }
      )
    ).toEqual([
      {
        kind: "error",
        message: `Run ${runId} failed · ${definitionId}`,
      },
    ]);
  });

  it("keeps chronological sequence numbers while bounding retained entries", () => {
    const first = appendSessionActivity(
      emptySessionActivity(),
      {
        kind: "status",
        message: "Run run-1 started",
        occurredAt: new Date("2026-08-29T12:00:00.000Z"),
      },
      2
    );
    const second = appendSessionActivity(
      first,
      {
        kind: "notice",
        message: "Run run-1 stopped",
        occurredAt: new Date("2026-08-29T12:00:01.000Z"),
      },
      2
    );
    const third = appendSessionActivity(
      second,
      {
        kind: "error",
        message: "Run run-2 failed",
        occurredAt: new Date("2026-08-29T12:00:02.000Z"),
      },
      2
    );

    expect(third).toMatchObject({
      nextSequence: 4,
      omitted: 1,
    });
    expect(
      third.entries.map(({ message, sequence }) => ({ message, sequence }))
    ).toEqual([
      { message: "Run run-1 stopped", sequence: 2 },
      { message: "Run run-2 failed", sequence: 3 },
    ]);
  });

  it("serializes one complete activity entry per JSON line", () => {
    const state = appendSessionActivity(emptySessionActivity(), {
      kind: "error",
      message: "Unable to observe dashboard\nConnection closed",
      occurredAt: new Date("2026-08-29T12:00:00.000Z"),
    });

    expect(sessionActivityJsonLines(state.entries)).toBe(
      '{"kind":"error","message":"Unable to observe dashboard\\nConnection closed","occurredAt":"2026-08-29T12:00:00.000Z","sequence":1}'
    );
  });

  it("exports JSON Lines without overwriting an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migrate-activity-"));
    temporaryDirectories.push(directory);
    const state = appendSessionActivity(emptySessionActivity(), {
      kind: "notice",
      message: "Run run-1 completed",
      occurredAt: new Date("2026-08-29T12:00:00.000Z"),
    });
    const exportedPath = await exportSessionActivity(
      state.entries,
      "exports/activity.jsonl",
      directory
    );

    expect(exportedPath).toBe(join(directory, "exports/activity.jsonl"));
    expect(await readFile(exportedPath, "utf8")).toBe(
      `${sessionActivityJsonLines(state.entries)}\n`
    );
    await expect(
      exportSessionActivity(state.entries, "exports/activity.jsonl", directory)
    ).rejects.toThrow("That file already exists. Choose a different file.");
  });

  it("uses a filesystem-safe default export name", () => {
    expect(
      defaultSessionActivityExportPath(new Date("2026-08-29T12:34:56.789Z"))
    ).toBe("migrate-activity-20260829-123456.jsonl");
  });
});
