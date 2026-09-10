import {
  beginMigrationRunExecutionEnvelope,
  cancelMigrationRunExecutionEnvelope,
  completeMigrationRunExecutionEnvelope,
  disableWorkflowStepRetries,
  executeMigrationRollbackExecutionEnvelope,
  executeMigrationRunCursorWindow,
  executeMigrationRunRollbackOrphansPage,
  failMigrationRunExecutionEnvelope,
} from "@migrate-sdk/workflow-sdk/steps";
import type {
  WorkflowSdkMigrationRollbackEnvelope,
  WorkflowSdkMigrationRollbackSummary,
  WorkflowSdkMigrationRunCursorWindowResult,
  WorkflowSdkMigrationRunCursorWindowState,
  WorkflowSdkMigrationRunEnvelope,
  WorkflowSdkMigrationRunRollbackOrphansPageResult,
  WorkflowSdkMigrationRunRollbackOrphansState,
  WorkflowSdkMigrationRunSummary,
} from "@migrate-sdk/workflow-sdk/workflow";
import { Effect, Layer } from "effect";
import {
  MigrationDefinitionRegistryCatalog,
  MigrationRollbackExecutor,
  MigrationRunStepExecutor,
} from "migrate-sdk/core";
import { migrationTelemetryLayer } from "migrate-sdk/telemetry";
import { getStepMetadata, getWorkflowMetadata } from "workflow";
import { catalogRegistry } from "./catalog";
import { migrationStore } from "./database";

const RuntimeLive = Layer.mergeAll(
  migrationStore,
  MigrationDefinitionRegistryCatalog.layer({
    registries: [catalogRegistry],
  }),
  MigrationRollbackExecutor.layer,
  MigrationRunStepExecutor.defaultLayer
);

const runEffect = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | MigrationDefinitionRegistryCatalog
    | MigrationRollbackExecutor
    | MigrationRunStepExecutor
  >,
  name: string,
  envelope:
    | WorkflowSdkMigrationRunEnvelope
    | WorkflowSdkMigrationRollbackEnvelope,
  definitionId?: string
) => {
  const step = getStepMetadata();
  const workflow = getWorkflowMetadata();
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(RuntimeLive),
      Effect.withSpan(`workflow.step.${name}`, {
        attributes: {
          "migration.run.id": envelope.runId,
          ...(definitionId === undefined
            ? {}
            : { "migration.definition.id": definitionId }),
          "workflow.run.id": workflow.workflowRunId,
          "workflow.name": workflow.workflowName,
          "workflow.step.id": step.stepId,
          "workflow.step.name": step.stepName,
          "workflow.step.attempt": step.attempt,
        },
      }),
      Effect.provide(migrationTelemetryLayer)
    )
  );
};

export async function beginMigrationRunStep(
  envelope: WorkflowSdkMigrationRunEnvelope
): Promise<{ readonly rollbackOrphans: boolean }> {
  "use step";

  return await runEffect(
    beginMigrationRunExecutionEnvelope(envelope),
    "begin",
    envelope
  );
}

export async function executeMigrationRunCursorWindowStep(input: {
  readonly definitionId: WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
  readonly state: WorkflowSdkMigrationRunCursorWindowState;
}): Promise<WorkflowSdkMigrationRunCursorWindowResult> {
  "use step";

  return await runEffect(
    executeMigrationRunCursorWindow({
      definitionId: input.definitionId,
      envelope: input.envelope,
      runId: input.runId,
      state: input.state,
    }),
    "cursor-window",
    input.envelope,
    input.definitionId
  );
}

export async function executeMigrationRunRollbackOrphansPageStep(input: {
  readonly definitionId: WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly runId: WorkflowSdkMigrationRunEnvelope["runId"];
  readonly state: WorkflowSdkMigrationRunRollbackOrphansState;
}): Promise<WorkflowSdkMigrationRunRollbackOrphansPageResult> {
  "use step";

  return await runEffect(
    executeMigrationRunRollbackOrphansPage({
      definitionId: input.definitionId,
      envelope: input.envelope,
      runId: input.runId,
      state: input.state,
    }),
    "rollback-orphans-page",
    input.envelope,
    input.definitionId
  );
}

export async function completeMigrationRunStep(input: {
  readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
}): Promise<WorkflowSdkMigrationRunSummary> {
  "use step";

  return await runEffect(
    completeMigrationRunExecutionEnvelope({
      definitions: input.definitions,
      envelope: input.envelope,
    }),
    "complete",
    input.envelope
  );
}

export async function cancelMigrationRunStep(input: {
  readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
}): Promise<WorkflowSdkMigrationRunSummary> {
  "use step";

  return await runEffect(
    cancelMigrationRunExecutionEnvelope({
      definitions: input.definitions,
      envelope: input.envelope,
    }),
    "cancel",
    input.envelope
  );
}

export async function failMigrationRunStep(input: {
  readonly definitions: WorkflowSdkMigrationRunSummary["definitions"];
  readonly envelope: WorkflowSdkMigrationRunEnvelope;
  readonly error: unknown;
  readonly failedDefinitionId?: WorkflowSdkMigrationRunEnvelope["executionDefinitionIds"][number];
}): Promise<void> {
  "use step";

  return await runEffect(
    failMigrationRunExecutionEnvelope({
      definitions: input.definitions,
      envelope: input.envelope,
      error: input.error,
      ...(input.failedDefinitionId === undefined
        ? {}
        : { failedDefinitionId: input.failedDefinitionId }),
    }),
    "fail",
    input.envelope,
    input.failedDefinitionId
  );
}

export async function executeMigrationRollbackStep(
  envelope: WorkflowSdkMigrationRollbackEnvelope
): Promise<WorkflowSdkMigrationRollbackSummary> {
  "use step";

  return await runEffect(
    executeMigrationRollbackExecutionEnvelope(envelope),
    "rollback",
    envelope
  );
}

disableWorkflowStepRetries(executeMigrationRunCursorWindowStep);
disableWorkflowStepRetries(executeMigrationRunRollbackOrphansPageStep);
