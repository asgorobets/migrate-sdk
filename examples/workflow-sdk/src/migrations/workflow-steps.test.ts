import type { WorkflowStepRetryMetadata } from "@migrate-sdk/workflow-sdk/steps";
import { describe, expect, it } from "vitest";
import {
  beginMigrationRunStep,
  cancelMigrationRunStep,
  completeMigrationRunStep,
  executeMigrationRollbackStep,
  executeMigrationRunCursorWindowStep,
  executeMigrationRunRollbackOrphansPageStep,
  failMigrationRunStep,
} from "./workflow-steps";

describe("migration Workflow steps", () => {
  it("disables automatic retries only for cursor-work steps", () => {
    const steps = [
      beginMigrationRunStep,
      cancelMigrationRunStep,
      completeMigrationRunStep,
      executeMigrationRollbackStep,
      executeMigrationRunCursorWindowStep,
      executeMigrationRunRollbackOrphansPageStep,
      failMigrationRunStep,
    ] as readonly Partial<WorkflowStepRetryMetadata>[];

    expect(steps.map((step) => step.maxRetries)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      0,
      undefined,
    ]);
  });
});
