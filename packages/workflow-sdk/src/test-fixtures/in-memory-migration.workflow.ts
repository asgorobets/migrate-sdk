import {
  runMigrationExecutionWorkflow,
  runMigrationRollbackWorkflow,
  type WorkflowSdkMigrationExecutionEnvelope,
  type WorkflowSdkMigrationRollbackSummary,
  type WorkflowSdkMigrationRunSummary,
} from "@migrate-sdk/workflow-sdk/workflow";
import {
  beginMigrationRunStep,
  completeMigrationRunStep,
  executeMigrationRollbackStep,
  executeMigrationRunCursorWindowStep,
  executeMigrationRunRollbackOrphansPageStep,
  failMigrationRunStep,
  inspectMigrationStoreStep,
} from "./in-memory-migration.steps.ts";

export async function inMemoryMigrationTestWorkflow(
  envelope: WorkflowSdkMigrationExecutionEnvelope
): Promise<{
  readonly snapshot: {
    readonly definitionLockCount: number;
    readonly itemStateCount: number;
    readonly latestRunStatus: string | undefined;
    readonly migratedItemStateCount: number;
    readonly rollbackCallCount: number;
    readonly sourceCursorCommitCount: number;
  };
  readonly summary:
    | WorkflowSdkMigrationRunSummary
    | WorkflowSdkMigrationRollbackSummary;
}> {
  "use workflow";

  const summary =
    envelope.kind === "rollback"
      ? await runMigrationRollbackWorkflow(envelope, {
          execute: executeMigrationRollbackStep,
        })
      : await runMigrationExecutionWorkflow(envelope, {
          begin: beginMigrationRunStep,
          complete: completeMigrationRunStep,
          executeCursorWindow: executeMigrationRunCursorWindowStep,
          executeRollbackOrphansPage:
            executeMigrationRunRollbackOrphansPageStep,
          fail: failMigrationRunStep,
        });
  const snapshot = await inspectMigrationStoreStep();

  return {
    snapshot,
    summary,
  };
}
