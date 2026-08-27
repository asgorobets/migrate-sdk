import {
  runMigrationExecutionWorkflow,
  runMigrationRollbackWorkflow,
  type WorkflowSdkMigrationRollbackEnvelope,
  type WorkflowSdkMigrationRollbackSummary,
  type WorkflowSdkMigrationRunEnvelope,
  type WorkflowSdkMigrationRunSummary,
} from "@migrate-sdk/workflow-sdk/workflow";
import {
  beginMigrationRunStep,
  completeMigrationRunStep,
  executeMigrationRollbackStep,
  executeMigrationRunCursorWindowStep,
  executeMigrationRunRollbackOrphansPageStep,
  failMigrationRunStep,
} from "./workflow-steps";

export async function catalogMigrationWorkflow(
  envelope:
    | WorkflowSdkMigrationRunEnvelope
    | WorkflowSdkMigrationRollbackEnvelope
): Promise<
  WorkflowSdkMigrationRunSummary | WorkflowSdkMigrationRollbackSummary
> {
  "use workflow";

  if (envelope.kind === "rollback") {
    return await runMigrationRollbackWorkflow(envelope, {
      execute: executeMigrationRollbackStep,
    });
  }

  return await runMigrationExecutionWorkflow(envelope, {
    begin: beginMigrationRunStep,
    complete: completeMigrationRunStep,
    executeCursorWindow: executeMigrationRunCursorWindowStep,
    executeRollbackOrphansPage: executeMigrationRunRollbackOrphansPageStep,
    fail: failMigrationRunStep,
  });
}
