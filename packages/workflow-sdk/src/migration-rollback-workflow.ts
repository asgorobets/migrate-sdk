import type { WorkflowSdkMigrationDefinitionLock } from "./migration-execution-workflow.ts";

export interface WorkflowSdkMigrationRollbackEnvelope {
  readonly executionDefinitionIds: readonly string[];
  readonly kind: "rollback";
  readonly locks: readonly WorkflowSdkMigrationDefinitionLock[];
  readonly registryId: string;
  readonly request: unknown;
  readonly runId: string;
  readonly scopeDefinitionIds: readonly string[];
}

export interface WorkflowSdkMigrationRollbackDefinitionCounts {
  readonly failed: number;
  readonly rolledBack: number;
  readonly skipped: number;
}

export interface WorkflowSdkMigrationRollbackDefinitionSummary {
  readonly counts: WorkflowSdkMigrationRollbackDefinitionCounts;
  readonly definitionId: string;
  readonly status: "failed" | "skipped" | "succeeded";
}

export interface WorkflowSdkMigrationRollbackSummary {
  readonly definitions: readonly WorkflowSdkMigrationRollbackDefinitionSummary[];
  readonly finishedAt: Date;
  readonly kind: "rollback";
  readonly runId: string;
  readonly startedAt: Date;
  readonly status: "failed" | "succeeded";
}

export interface WorkflowSdkMigrationRollbackSteps {
  readonly execute: (
    envelope: WorkflowSdkMigrationRollbackEnvelope
  ) => Promise<WorkflowSdkMigrationRollbackSummary>;
}

export const runMigrationRollbackWorkflow = async (
  envelope: WorkflowSdkMigrationRollbackEnvelope,
  steps: WorkflowSdkMigrationRollbackSteps
): Promise<WorkflowSdkMigrationRollbackSummary> => steps.execute(envelope);
