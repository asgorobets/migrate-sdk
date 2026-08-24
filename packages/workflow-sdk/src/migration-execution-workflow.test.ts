import { describe, expect, it, vi } from "vitest";
import {
  runMigrationExecutionWorkflow,
  type WorkflowSdkMigrationRunEnvelope,
  type WorkflowSdkMigrationRunSteps,
} from "./migration-execution-workflow.ts";

const makeEnvelope = (): WorkflowSdkMigrationRunEnvelope => ({
  executionDefinitionIds: ["articles"],
  kind: "run",
  locks: [
    {
      definitionId: "articles",
      ownerRunId: "run-1",
      token: "lock-1",
    },
  ],
  registryId: "catalog",
  request: {
    definitionIds: ["articles"],
  },
  runId: "run-1",
  scopeDefinitionIds: ["articles"],
});

describe("runMigrationExecutionWorkflow", () => {
  it("does not start rollback orphans after a cancelled scan", async () => {
    const cancellation = new Error(
      "Migration run was cancelled while scanning articles"
    );
    const executeRollbackOrphansPage = vi.fn();
    const fail = vi.fn<WorkflowSdkMigrationRunSteps["fail"]>();
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: true }),
      complete: vi.fn(),
      executeCursorWindow: vi.fn().mockResolvedValue({
        kind: "cancelled",
        state: {
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          excludedSourceIdentities: [],
          phase: "scan",
        },
      }),
      executeRollbackOrphansPage,
      fail,
    };

    await expect(
      runMigrationExecutionWorkflow(makeEnvelope(), steps)
    ).rejects.toEqual(cancellation);
    expect(executeRollbackOrphansPage).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        definitions: [],
        failedDefinitionId: "articles",
      })
    );
  });

  it("reports completed and active definitions when a later scan fails", async () => {
    const envelope: WorkflowSdkMigrationRunEnvelope = {
      ...makeEnvelope(),
      executionDefinitionIds: ["authors", "articles", "assets"],
    };
    const sourceError = new Error("Article source is unavailable");
    const fail = vi.fn<WorkflowSdkMigrationRunSteps["fail"]>();
    const executeCursorWindow = vi.fn(({ definitionId }) => {
      if (definitionId === "articles") {
        return Promise.reject(sourceError);
      }

      return Promise.resolve({
        kind: "definition-completed" as const,
        state: {
          counts: {
            failed: 0,
            migrated: 1,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          excludedSourceIdentities: [],
          phase: "scan" as const,
        },
        summary: {
          counts: {
            failed: 0,
            migrated: 1,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          definitionId,
          status: "succeeded" as const,
        },
      });
    });
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: false }),
      complete: vi.fn(),
      executeCursorWindow,
      executeRollbackOrphansPage: vi.fn(),
      fail,
    };

    await expect(runMigrationExecutionWorkflow(envelope, steps)).rejects.toBe(
      sourceError
    );

    expect(executeCursorWindow).toHaveBeenCalledTimes(2);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        definitions: [
          expect.objectContaining({
            definitionId: "authors",
            status: "succeeded",
          }),
        ],
        failedDefinitionId: "articles",
      })
    );
  });

  it("finishes every scan before rolling back orphans in reverse order", async () => {
    const envelope: WorkflowSdkMigrationRunEnvelope = {
      ...makeEnvelope(),
      executionDefinitionIds: ["assets", "articles"],
    };
    const calls: string[] = [];
    const definitionSummary = (definitionId: string) => ({
      counts: {
        failed: 0,
        migrated: 0,
        needsUpdate: 0,
        skipped: 0,
        unchanged: 1,
      },
      definitionId,
      status: "succeeded" as const,
    });
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: true }),
      complete: vi.fn(async ({ definitions }) => ({
        definitions,
        finishedAt: new Date(2),
        runId: "run-1",
        startedAt: new Date(1),
        status: "succeeded" as const,
      })),
      executeCursorWindow: vi.fn(({ definitionId }) => {
        calls.push(`scan:${definitionId}`);
        const summary = definitionSummary(definitionId);
        return Promise.resolve({
          kind: "definition-completed" as const,
          state: {
            counts: summary.counts,
            excludedSourceIdentities: [],
            phase: "scan" as const,
          },
          summary,
        });
      }),
      executeRollbackOrphansPage: vi.fn(({ definitionId, state }) => {
        calls.push(`rollback:${definitionId}`);
        return Promise.resolve({
          kind: "completed" as const,
          state: {
            ...state,
            orphaned: 1,
            rollbackFailed: 0,
            rolledBack: 1,
          },
        });
      }),
      fail: vi.fn(),
    };

    const result = await runMigrationExecutionWorkflow(envelope, steps);

    expect(calls).toEqual([
      "scan:assets",
      "scan:articles",
      "rollback:articles",
      "rollback:assets",
    ]);
    expect(result.definitions.map((definition) => definition.counts)).toEqual([
      expect.objectContaining({ orphaned: 1, rolledBack: 1 }),
      expect.objectContaining({ orphaned: 1, rolledBack: 1 }),
    ]);
  });

  it("reports only completed rollbacks when a later rollback fails", async () => {
    const envelope: WorkflowSdkMigrationRunEnvelope = {
      ...makeEnvelope(),
      executionDefinitionIds: ["authors", "articles", "assets"],
    };
    const rollbackError = new Error("article rollback unavailable");
    const fail = vi.fn<WorkflowSdkMigrationRunSteps["fail"]>();
    const rollbackCalls: string[] = [];
    const definitionSummary = (definitionId: string) => ({
      counts: {
        failed: 0,
        migrated: 0,
        needsUpdate: 0,
        skipped: 0,
        unchanged: 1,
      },
      definitionId,
      status: "succeeded" as const,
    });
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: true }),
      complete: vi.fn(),
      executeCursorWindow: vi.fn(({ definitionId }) => {
        const summary = definitionSummary(definitionId);
        return Promise.resolve({
          kind: "definition-completed" as const,
          state: {
            counts: summary.counts,
            excludedSourceIdentities: [],
            phase: "scan" as const,
          },
          summary,
        });
      }),
      executeRollbackOrphansPage: vi.fn(({ definitionId, state }) => {
        rollbackCalls.push(definitionId);

        if (definitionId === "articles") {
          return Promise.reject(rollbackError);
        }

        return Promise.resolve({
          kind: "completed" as const,
          state: {
            ...state,
            orphaned: 1,
            rolledBack: 1,
          },
        });
      }),
      fail,
    };

    await expect(runMigrationExecutionWorkflow(envelope, steps)).rejects.toBe(
      rollbackError
    );

    expect(rollbackCalls).toEqual(["assets", "articles"]);
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        definitions: [
          expect.objectContaining({
            definitionId: "assets",
            status: "succeeded",
          }),
        ],
        failedDefinitionId: "articles",
      })
    );
  });

  it("carries rollback page cursor and counts in workflow state", async () => {
    const pageStates: unknown[] = [];
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: true }),
      complete: vi.fn(async ({ definitions }) => ({
        definitions,
        finishedAt: new Date(2),
        runId: "run-1",
        startedAt: new Date(1),
        status: "succeeded" as const,
      })),
      executeCursorWindow: vi.fn().mockResolvedValue({
        kind: "definition-completed",
        state: {
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 1,
          },
          excludedSourceIdentities: [],
          phase: "scan",
        },
        summary: {
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 1,
          },
          definitionId: "articles",
          status: "succeeded",
        },
      }),
      executeRollbackOrphansPage: vi.fn(({ state }) => {
        pageStates.push(state);
        return pageStates.length === 1
          ? Promise.resolve({
              kind: "continue" as const,
              state: {
                ...state,
                afterIdentity: "article-100",
                orphaned: 100,
                rolledBack: 100,
              },
            })
          : Promise.resolve({
              kind: "completed" as const,
              state: {
                ...state,
                orphaned: 101,
                rolledBack: 101,
              },
            });
      }),
      fail: vi.fn(),
    };

    const result = await runMigrationExecutionWorkflow(makeEnvelope(), steps);

    expect(pageStates).toEqual([
      {
        orphaned: 0,
        phase: "rollback",
        rollbackFailed: 0,
        rolledBack: 0,
      },
      {
        afterIdentity: "article-100",
        orphaned: 100,
        phase: "rollback",
        rollbackFailed: 0,
        rolledBack: 100,
      },
    ]);
    expect(result.definitions[0]?.counts).toEqual(
      expect.objectContaining({ orphaned: 101, rolledBack: 101 })
    );
  });

  it("does not complete after rollback-orphan cancellation", async () => {
    const complete = vi.fn<WorkflowSdkMigrationRunSteps["complete"]>();
    const fail = vi.fn<WorkflowSdkMigrationRunSteps["fail"]>();
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: true }),
      complete,
      executeCursorWindow: vi.fn().mockResolvedValue({
        kind: "definition-completed",
        state: {
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 1,
          },
          excludedSourceIdentities: [],
          phase: "scan",
        },
        summary: {
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 1,
          },
          definitionId: "articles",
          status: "succeeded",
        },
      }),
      executeRollbackOrphansPage: vi.fn(({ state }) =>
        Promise.resolve({ kind: "cancelled" as const, state })
      ),
      fail,
    };

    await expect(
      runMigrationExecutionWorkflow(makeEnvelope(), steps)
    ).rejects.toThrow(
      "Migration run was cancelled while rolling back orphans for articles"
    );
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
  });

  it("reports zero rollback-orphans counts when a scan fails", async () => {
    const executeRollbackOrphansPage = vi.fn();
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: true }),
      complete: vi.fn(async ({ definitions }) => ({
        definitions,
        finishedAt: new Date(2),
        runId: "run-1",
        startedAt: new Date(1),
        status: "failed" as const,
      })),
      executeCursorWindow: vi.fn().mockResolvedValue({
        kind: "definition-completed",
        state: {
          counts: {
            failed: 1,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          excludedSourceIdentities: [],
          phase: "scan",
        },
        summary: {
          counts: {
            failed: 1,
            migrated: 0,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          definitionId: "articles",
          status: "failed",
        },
      }),
      executeRollbackOrphansPage,
      fail: vi.fn(),
    };

    const result = await runMigrationExecutionWorkflow(makeEnvelope(), steps);

    expect(executeRollbackOrphansPage).not.toHaveBeenCalled();
    expect(result.definitions[0]?.counts).toEqual({
      failed: 1,
      migrated: 0,
      needsUpdate: 0,
      orphaned: 0,
      rollbackFailed: 0,
      rolledBack: 0,
      skipped: 0,
      unchanged: 0,
    });
  });

  it("does not call fail when completion fails after execution succeeds", async () => {
    const completionError = new Error("complete failed");
    const fail = vi.fn<WorkflowSdkMigrationRunSteps["fail"]>();
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue({ rollbackOrphans: false }),
      complete: vi.fn().mockRejectedValue(completionError),
      executeCursorWindow: vi.fn().mockResolvedValue({
        kind: "definition-completed",
        state: {
          counts: {
            failed: 0,
            migrated: 1,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          excludedSourceIdentities: [],
          phase: "scan",
        },
        summary: {
          counts: {
            failed: 0,
            migrated: 1,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          definitionId: "articles",
          status: "succeeded",
        },
      }),
      executeRollbackOrphansPage: vi.fn(),
      fail,
    };

    await expect(
      runMigrationExecutionWorkflow(makeEnvelope(), steps)
    ).rejects.toBe(completionError);

    expect(fail).not.toHaveBeenCalled();
  });
});
