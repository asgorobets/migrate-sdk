import {
  runMigrationExecutionWorkflow,
  type WorkflowSdkMigrationRunEnvelope,
  type WorkflowSdkMigrationRunSummary,
} from "@migrate-sdk/workflow-sdk/workflow";
import {
  beginMigrationRunStep,
  completeMigrationRunStep,
  executeMigrationRunCursorWindowStep,
  executeMigrationRunRollbackOrphansPageStep,
  failMigrationRunStep,
  inspectMigrationStoreStep,
} from "./in-memory-migration.steps.ts";

export async function inMemoryMigrationTestWorkflow(
  envelope: WorkflowSdkMigrationRunEnvelope
): Promise<{
  readonly snapshot: {
    readonly definitionLockCount: number;
    readonly itemStateCount: number;
    readonly latestRunStatus: string | undefined;
    readonly migratedItemStateCount: number;
    readonly rollbackCallCount: number;
    readonly sourceCursorCommitCount: number;
  };
  readonly summary: WorkflowSdkMigrationRunSummary;
}> {
  "use workflow";

  const summary = await runMigrationExecutionWorkflow(envelope, {
    begin: beginMigrationRunStep,
    complete: completeMigrationRunStep,
    executeCursorWindow: executeMigrationRunCursorWindowStep,
    executeRollbackOrphansPage: executeMigrationRunRollbackOrphansPageStep,
    fail: failMigrationRunStep,
  });
  const snapshot = await inspectMigrationStoreStep();

  return {
    snapshot,
    summary,
  };
}
