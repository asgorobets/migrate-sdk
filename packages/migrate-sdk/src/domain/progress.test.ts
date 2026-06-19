import { describe, expect, it } from "@effect/vitest";
import {
  initialMigrationProgressState,
  type MigrationProgressEvent,
  reduceMigrationProgressState,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "../index.ts";

describe("Migration Progress state", () => {
  it("reduces run, definition, and Source Cursor Window progress into aggregate state", () => {
    const runId = toMigrationRunId("run-progress");
    const articles = toMigrationDefinitionId("articles");
    const authors = toMigrationDefinitionId("authors");
    const events: readonly MigrationProgressEvent[] = [
      {
        definitionIds: [articles, authors],
        kind: "run-started",
        runId,
      },
      {
        definitionId: articles,
        kind: "definition-started",
        runId,
      },
      {
        counts: {
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        },
        definitionId: articles,
        itemsRead: 2,
        kind: "source-cursor-window-completed",
        runId,
      },
      {
        counts: {
          migrated: 2,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        },
        definitionId: articles,
        kind: "definition-completed",
        runId,
        status: "succeeded",
      },
      {
        definitionId: authors,
        kind: "definition-started",
        runId,
      },
    ];

    const state = events.reduce(
      reduceMigrationProgressState,
      initialMigrationProgressState
    );

    expect(state).toEqual({
      activeDefinitionId: authors,
      definitionIds: [articles, authors],
      definitions: [
        {
          counts: {
            migrated: 2,
            skipped: 0,
            failed: 0,
            unchanged: 0,
            needsUpdate: 0,
          },
          cursorWindowsCompleted: 1,
          definitionId: articles,
          itemsRead: 2,
          status: "succeeded",
        },
        {
          counts: {
            migrated: 0,
            skipped: 0,
            failed: 0,
            unchanged: 0,
            needsUpdate: 0,
          },
          cursorWindowsCompleted: 0,
          definitionId: authors,
          itemsRead: 0,
          status: "running",
        },
      ],
      runId,
      status: "running",
    });
  });

  it("clears the active Migration Definition when progress reaches a terminal state", () => {
    const runId = toMigrationRunId("run-progress");
    const articles = toMigrationDefinitionId("articles");
    const completedEvents: readonly MigrationProgressEvent[] = [
      {
        definitionIds: [articles],
        kind: "run-started",
        runId,
      },
      {
        definitionId: articles,
        kind: "definition-started",
        runId,
      },
      {
        counts: {
          migrated: 1,
          skipped: 0,
          failed: 0,
          unchanged: 0,
          needsUpdate: 0,
        },
        definitionId: articles,
        kind: "definition-completed",
        runId,
        status: "succeeded",
      },
    ];

    const completedState = completedEvents.reduce(
      reduceMigrationProgressState,
      initialMigrationProgressState
    );
    const terminalState = reduceMigrationProgressState(completedState, {
      definitionIds: [articles],
      kind: "run-completed",
      runId,
      status: "succeeded",
    });
    const failedState = reduceMigrationProgressState(completedState, {
      definitionIds: [articles],
      error: new Error("failed"),
      kind: "run-failed",
      runId,
    });

    expect(completedState.activeDefinitionId).toBeUndefined();
    expect(terminalState.activeDefinitionId).toBeUndefined();
    expect(failedState.activeDefinitionId).toBeUndefined();
  });
});
