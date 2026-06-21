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
  it("does not call fail when completion fails after execution succeeds", async () => {
    const completionError = new Error("complete failed");
    const fail = vi.fn<WorkflowSdkMigrationRunSteps["fail"]>();
    const steps: WorkflowSdkMigrationRunSteps = {
      begin: vi.fn().mockResolvedValue(undefined),
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
      fail,
    };

    await expect(
      runMigrationExecutionWorkflow(makeEnvelope(), steps)
    ).rejects.toBe(completionError);

    expect(fail).not.toHaveBeenCalled();
  });
});
