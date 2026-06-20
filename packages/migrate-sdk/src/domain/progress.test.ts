import { describe, expect, it } from "@effect/vitest";
import {
  initialMigrationProgressState,
  type MigrationProgressEvent,
  reduceMigrationProgressState,
  SourceItemTotal,
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
          warnings: [],
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
          warnings: [],
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

  it("stores known and unknown Source Item totals per active Migration Definition", () => {
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
        definitionId: articles,
        kind: "source-item-total-counted",
        runId,
        sourceItemTotal: SourceItemTotal.known(3),
      },
      {
        definitionId: authors,
        kind: "definition-started",
        runId,
      },
      {
        definitionId: authors,
        kind: "source-item-total-counted",
        runId,
        sourceItemTotal: SourceItemTotal.unknown({
          reason: "unsupported",
        }),
      },
    ];

    const state = events.reduce(
      reduceMigrationProgressState,
      initialMigrationProgressState
    );

    expect(state.definitions).toEqual([
      expect.objectContaining({
        definitionId: articles,
        sourceItemTotal: SourceItemTotal.known(3),
        warnings: [],
      }),
      expect.objectContaining({
        definitionId: authors,
        sourceItemTotal: SourceItemTotal.unknown({
          reason: "unsupported",
        }),
        warnings: [],
      }),
    ]);
  });

  it("caps known Source Item totals by the active item limit without deriving percentages", () => {
    const runId = toMigrationRunId("run-progress");
    const articles = toMigrationDefinitionId("articles");
    const state = reduceMigrationProgressState(
      reduceMigrationProgressState(initialMigrationProgressState, {
        definitionIds: [articles],
        kind: "run-started",
        runId,
      }),
      {
        definitionId: articles,
        itemLimit: 2,
        kind: "source-item-total-counted",
        runId,
        sourceItemTotal: SourceItemTotal.known(5),
      }
    );
    const definition = state.definitions[0] as
      | (typeof state.definitions)[number]
      | undefined;
    const rawDefinition = definition as Record<string, unknown> | undefined;

    expect(definition?.sourceItemTotal).toEqual(SourceItemTotal.known(2));
    expect(rawDefinition?.percentage).toBeUndefined();
    expect(rawDefinition?.remaining).toBeUndefined();
  });

  it("keeps lower-bound Source Item totals unless the item limit makes the run total known", () => {
    const runId = toMigrationRunId("run-progress");
    const articles = toMigrationDefinitionId("articles");
    const lowerBound = SourceItemTotal.lowerBound(10_000, {
      message: "Source total is capped",
      reason: "capped",
    });
    const uncappedState = reduceMigrationProgressState(
      reduceMigrationProgressState(initialMigrationProgressState, {
        definitionIds: [articles],
        kind: "run-started",
        runId,
      }),
      {
        definitionId: articles,
        itemLimit: 20_000,
        kind: "source-item-total-counted",
        runId,
        sourceItemTotal: lowerBound,
      }
    );
    const knownLimitedState = reduceMigrationProgressState(
      reduceMigrationProgressState(initialMigrationProgressState, {
        definitionIds: [articles],
        kind: "run-started",
        runId,
      }),
      {
        definitionId: articles,
        itemLimit: 500,
        kind: "source-item-total-counted",
        runId,
        sourceItemTotal: lowerBound,
      }
    );

    expect(uncappedState.definitions[0]?.sourceItemTotal).toEqual(lowerBound);
    expect(knownLimitedState.definitions[0]?.sourceItemTotal).toEqual(
      SourceItemTotal.known(500)
    );
  });

  it("records a progress warning when Source Item total count fails", () => {
    const runId = toMigrationRunId("run-progress");
    const articles = toMigrationDefinitionId("articles");
    const cause = new Error("count failed");
    const state = reduceMigrationProgressState(initialMigrationProgressState, {
      definitionId: articles,
      kind: "source-item-total-counted",
      runId,
      sourceItemTotal: SourceItemTotal.unknown({
        cause,
        message: "Unable to count articles",
        reason: "failed",
      }),
    });

    expect(state.definitions[0]).toEqual(
      expect.objectContaining({
        definitionId: articles,
        sourceItemTotal: SourceItemTotal.unknown({
          cause,
          message: "Unable to count articles",
          reason: "failed",
        }),
        warnings: [
          {
            cause,
            definitionId: articles,
            kind: "source-item-total-count-failed",
            message: "Unable to count articles",
          },
        ],
      })
    );
  });
});
