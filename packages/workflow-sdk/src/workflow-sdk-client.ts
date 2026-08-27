import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import {
  getRun as getWorkflowRun,
  type Run,
  type StartOptions,
  start as startWorkflow,
} from "workflow/api";
import type { WorkflowSdkMigrationExecutionEnvelope } from "./migration-envelope.ts";

export type WorkflowSdkRun = Run<unknown>;

export type WorkflowSdkMigrationWorkflow = (
  envelope: WorkflowSdkMigrationExecutionEnvelope
) => Promise<unknown>;

export interface WorkflowSdkWorkflowMetadata {
  readonly workflowId: string;
}

export type WorkflowSdkStartOptions = StartOptions;

type WorkflowSdkStartOptionsWithDeploymentId = Extract<
  WorkflowSdkStartOptions,
  { readonly deploymentId: "latest" | (string & {}) }
>;

type WorkflowSdkStartOptionsWithoutDeploymentId = Extract<
  WorkflowSdkStartOptions,
  { readonly deploymentId?: undefined }
>;

export interface WorkflowSdkClientStartInput {
  readonly envelope: WorkflowSdkMigrationExecutionEnvelope;
  readonly options?: WorkflowSdkStartOptions;
  readonly workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata;
}

export class WorkflowSdkClientError extends Schema.TaggedError<WorkflowSdkClientError>()(
  "WorkflowSdkClientError",
  {
    cause: Schema.Defect(),
    operation: Schema.Literals(["get-run", "start"]),
  }
) {}

export interface WorkflowSdkClientService {
  readonly getRun: (
    executionId: string
  ) => Effect.Effect<WorkflowSdkRun, WorkflowSdkClientError>;
  readonly start: (
    input: WorkflowSdkClientStartInput
  ) => Effect.Effect<WorkflowSdkRun, WorkflowSdkClientError>;
}

const start = (
  workflow: WorkflowSdkMigrationWorkflow | WorkflowSdkWorkflowMetadata,
  envelope: WorkflowSdkMigrationExecutionEnvelope,
  options: WorkflowSdkStartOptions | undefined
): Promise<WorkflowSdkRun> =>
  options?.deploymentId === undefined
    ? startWorkflow(
        workflow,
        [envelope],
        options as WorkflowSdkStartOptionsWithoutDeploymentId | undefined
      )
    : startWorkflow(
        workflow,
        [envelope],
        options as WorkflowSdkStartOptionsWithDeploymentId
      );

/**
 * Provides the Workflow SDK control-plane capabilities used by the migration
 * executable. Tests can replace this layer without changing executable
 * construction.
 */
export class WorkflowSdkClient extends Service<
  WorkflowSdkClient,
  WorkflowSdkClientService
>()("@migrate-sdk/workflow-sdk/WorkflowSdkClient") {
  static readonly layer = Layer.succeed(WorkflowSdkClient, {
    getRun: (executionId) =>
      Effect.try({
        try: () => getWorkflowRun(executionId),
        catch: (cause) =>
          new WorkflowSdkClientError({ cause, operation: "get-run" }),
      }),
    start: (input) =>
      Effect.tryPromise({
        try: () => start(input.workflow, input.envelope, input.options),
        catch: (cause) =>
          new WorkflowSdkClientError({ cause, operation: "start" }),
      }),
  });
}
