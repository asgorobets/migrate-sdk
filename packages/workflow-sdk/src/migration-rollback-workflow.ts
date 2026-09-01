import type { RollbackRunSummary } from "migrate-sdk/core";
import type { WorkflowSdkMigrationRollbackEnvelope } from "./migration-envelope.ts";

export type { WorkflowSdkMigrationRollbackEnvelope } from "./migration-envelope.ts";

export type WorkflowSdkMigrationRollbackDefinitionSummary =
  RollbackRunSummary["definitions"][number];

export type WorkflowSdkMigrationRollbackDefinitionCounts =
  WorkflowSdkMigrationRollbackDefinitionSummary["counts"];

export type WorkflowSdkMigrationRollbackSummary = RollbackRunSummary;

export interface WorkflowSdkMigrationRollbackSteps {
  readonly execute: (
    envelope: WorkflowSdkMigrationRollbackEnvelope
  ) => Promise<WorkflowSdkMigrationRollbackSummary>;
}

export const runMigrationRollbackWorkflow = async (
  envelope: WorkflowSdkMigrationRollbackEnvelope,
  steps: WorkflowSdkMigrationRollbackSteps
): Promise<WorkflowSdkMigrationRollbackSummary> => steps.execute(envelope);
