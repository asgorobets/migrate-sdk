import {
  runMigrationRollbackWorkflow,
  type WorkflowSdkMigrationRollbackEnvelope,
  type WorkflowSdkMigrationRollbackSummary,
} from "@migrate-sdk/workflow-sdk/workflow";
import {
  executeMigrationRollbackStep,
  inspectMigrationStoreStep,
} from "./in-memory-migration.steps.ts";

export async function inMemoryRollbackTestWorkflow(
  envelope: WorkflowSdkMigrationRollbackEnvelope
): Promise<{
  readonly snapshot: {
    readonly definitionLockCount: number;
    readonly itemStateCount: number;
    readonly latestRunStatus: string | undefined;
    readonly migratedItemStateCount: number;
    readonly sourceCursorCommitCount: number;
  };
  readonly summary: WorkflowSdkMigrationRollbackSummary;
}> {
  "use workflow";

  const summary = await runMigrationRollbackWorkflow(envelope, {
    execute: executeMigrationRollbackStep,
  });
  const snapshot = await inspectMigrationStoreStep();

  return {
    snapshot,
    summary,
  };
}
