import { describe, expect, it } from "@effect/vitest";
import {
  initialRollbackProgressState,
  type RollbackProgressEvent,
  reduceRollbackProgressState,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "../index.ts";

describe("Rollback Progress state", () => {
  it("reduces rollback, definition, and item progress into aggregate state", () => {
    const runId = toMigrationRunId("rollback-progress");
    const articles = toMigrationDefinitionId("articles");
    const authors = toMigrationDefinitionId("authors");
    const events: readonly RollbackProgressEvent[] = [
      {
        definitionIds: [articles, authors],
        kind: "rollback-started",
        runId,
      },
      {
        definitionId: articles,
        kind: "definition-started",
        runId,
      },
      {
        counts: {
          rolledBack: 1,
          skipped: 0,
          failed: 0,
        },
        definitionId: articles,
        kind: "source-item-completed",
        outcome: "rolled-back",
        runId,
      },
      {
        counts: {
          rolledBack: 1,
          skipped: 0,
          failed: 0,
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
      reduceRollbackProgressState,
      initialRollbackProgressState
    );

    expect(state).toEqual({
      activeDefinitionId: authors,
      definitionIds: [articles, authors],
      definitions: [
        {
          counts: {
            rolledBack: 1,
            skipped: 0,
            failed: 0,
          },
          definitionId: articles,
          itemsProcessed: 1,
          status: "succeeded",
        },
        {
          counts: {
            rolledBack: 0,
            skipped: 0,
            failed: 0,
          },
          definitionId: authors,
          itemsProcessed: 0,
          status: "running",
        },
      ],
      runId,
      status: "running",
    });
  });

  it("clears the active Migration Definition when rollback reaches a terminal state", () => {
    const runId = toMigrationRunId("rollback-progress");
    const articles = toMigrationDefinitionId("articles");
    const completedEvents: readonly RollbackProgressEvent[] = [
      {
        definitionIds: [articles],
        kind: "rollback-started",
        runId,
      },
      {
        definitionId: articles,
        kind: "definition-started",
        runId,
      },
      {
        counts: {
          rolledBack: 1,
          skipped: 0,
          failed: 0,
        },
        definitionId: articles,
        kind: "definition-completed",
        runId,
        status: "succeeded",
      },
    ];

    const completedState = completedEvents.reduce(
      reduceRollbackProgressState,
      initialRollbackProgressState
    );
    const terminalState = reduceRollbackProgressState(completedState, {
      definitionIds: [articles],
      kind: "rollback-completed",
      runId,
      status: "succeeded",
    });
    const failedState = reduceRollbackProgressState(completedState, {
      definitionIds: [articles],
      error: new Error("failed"),
      kind: "rollback-failed",
      runId,
    });

    expect(completedState.activeDefinitionId).toBeUndefined();
    expect(terminalState.activeDefinitionId).toBeUndefined();
    expect(failedState.activeDefinitionId).toBeUndefined();
  });
});
