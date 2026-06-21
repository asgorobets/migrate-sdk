import { Effect } from "effect";
import { MigrationExecutable } from "migrate-sdk";
import { expect, test } from "vitest";
import { getRun, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import type { WorkflowSdkMigrationRunEnvelope } from "./migration-execution-workflow.ts";
import type { WorkflowSdkMigrationRollbackEnvelope } from "./migration-rollback-workflow.ts";
import {
  beginMigrationRunStep,
  completeMigrationRunStep,
  executeMigrationRollbackStep,
  executeMigrationRunCursorWindowStep,
  failMigrationRunStep,
  inMemoryMigrationTestRegistry,
  resetInMemoryMigrationTestState,
} from "./test-fixtures/in-memory-migration.steps.ts";
import { inMemoryMigrationTestWorkflow } from "./test-fixtures/in-memory-migration.workflow.ts";
import { inMemoryRollbackTestWorkflow } from "./test-fixtures/in-memory-rollback.workflow.ts";
import type { WorkflowSdkMigrationWorkflow } from "./workflow-sdk-migration-executable.ts";
import { WorkflowSdkMigrationExecutable } from "./workflow-sdk-migration-executable.ts";

test("Workflow SDK executes a real in-memory migration run and rollback", async () => {
  resetInMemoryMigrationTestState();
  const runWorkflow =
    inMemoryMigrationTestWorkflow as WorkflowSdkMigrationWorkflow;
  const rollbackWorkflow =
    inMemoryRollbackTestWorkflow as WorkflowSdkMigrationWorkflow;

  const plan = await Effect.runPromise(
    inMemoryMigrationTestRegistry.executable().planRun({
      definitionIds: ["articles"],
    })
  );
  const started = await Effect.runPromise(
    MigrationExecutable.startRun(plan).pipe(
      Effect.provide(
        WorkflowSdkMigrationExecutable.layer({
          start: (workflow, args) =>
            start(
              workflow as typeof inMemoryMigrationTestWorkflow,
              args as unknown as [WorkflowSdkMigrationRunEnvelope]
            ),
          workflow: runWorkflow,
        })
      )
    )
  );

  expect(started.kind).toBe("started");
  if (started.kind !== "started") {
    throw new Error("Expected Workflow SDK adapter to start the run");
  }

  const executionId = started.execution.executionId;
  expect(executionId).toBeDefined();
  if (executionId === undefined) {
    throw new Error("Expected Workflow SDK adapter to attach an execution id");
  }

  const run =
    getRun<Awaited<ReturnType<typeof inMemoryMigrationTestWorkflow>>>(
      executionId
    );
  const result = await run.returnValue;
  const steps = await getWorld().steps.list({
    resolveData: "none",
    runId: run.runId,
  });
  const cursorWindowSteps = steps.data.filter((step) =>
    step.stepName.endsWith("//executeMigrationRunCursorWindowStep")
  );

  expect(await run.status).toBe("completed");
  expect(result.summary).toEqual(
    expect.objectContaining({
      definitions: [
        {
          counts: {
            failed: 0,
            migrated: 100,
            needsUpdate: 0,
            skipped: 0,
            unchanged: 0,
          },
          definitionId: "articles",
          status: "succeeded",
        },
      ],
      runId: started.runId,
      status: "succeeded",
    })
  );
  expect(result.snapshot).toEqual({
    definitionLockCount: 0,
    itemStateCount: 100,
    latestRunStatus: "succeeded",
    migratedItemStateCount: 100,
    sourceCursorCommitCount: 1,
  });
  expect(cursorWindowSteps).toHaveLength(2);
  expect(cursorWindowSteps.map((step) => step.status)).toEqual([
    "completed",
    "completed",
  ]);
  const migrationExecutionSteps = [
    beginMigrationRunStep,
    executeMigrationRunCursorWindowStep,
    completeMigrationRunStep,
    failMigrationRunStep,
  ] as readonly (typeof beginMigrationRunStep & {
    readonly maxRetries?: number;
  })[];
  expect(migrationExecutionSteps.map((step) => step.maxRetries)).toEqual([
    0, 0, 0, 0,
  ]);

  const rollbackPlan = await Effect.runPromise(
    inMemoryMigrationTestRegistry.executable().planRollback({
      definitionIds: ["articles"],
    })
  );
  const rollbackStarted = await Effect.runPromise(
    MigrationExecutable.startRollback(rollbackPlan).pipe(
      Effect.provide(
        WorkflowSdkMigrationExecutable.layer({
          start: (workflow, args) =>
            start(
              workflow as typeof inMemoryRollbackTestWorkflow,
              args as unknown as [WorkflowSdkMigrationRollbackEnvelope]
            ),
          workflow: rollbackWorkflow,
        })
      )
    )
  );

  expect(rollbackStarted.kind).toBe("started");
  if (rollbackStarted.kind !== "started") {
    throw new Error("Expected Workflow SDK adapter to start the rollback");
  }

  const rollbackExecutionId = rollbackStarted.execution.executionId;
  expect(rollbackExecutionId).toBeDefined();
  if (rollbackExecutionId === undefined) {
    throw new Error(
      "Expected Workflow SDK adapter to attach rollback execution id"
    );
  }

  const rollbackRun =
    getRun<Awaited<ReturnType<typeof inMemoryRollbackTestWorkflow>>>(
      rollbackExecutionId
    );
  const rollbackResult = await rollbackRun.returnValue;
  const rollbackSteps = await getWorld().steps.list({
    resolveData: "none",
    runId: rollbackRun.runId,
  });
  const rollbackExecutionSteps = rollbackSteps.data.filter((step) =>
    step.stepName.endsWith("//executeMigrationRollbackStep")
  );

  expect(await rollbackRun.status).toBe("completed");
  expect(rollbackResult.summary).toEqual(
    expect.objectContaining({
      definitions: [
        {
          counts: {
            failed: 0,
            rolledBack: 100,
            skipped: 0,
          },
          definitionId: "articles",
          status: "succeeded",
        },
      ],
      kind: "rollback",
      runId: rollbackStarted.runId,
      status: "succeeded",
    })
  );
  expect(rollbackResult.snapshot).toEqual({
    definitionLockCount: 0,
    itemStateCount: 0,
    latestRunStatus: "succeeded",
    migratedItemStateCount: 0,
    sourceCursorCommitCount: 1,
  });
  expect(rollbackExecutionSteps).toHaveLength(1);
  expect(rollbackExecutionSteps.map((step) => step.status)).toEqual([
    "completed",
  ]);
  expect(
    (
      executeMigrationRollbackStep as typeof executeMigrationRollbackStep & {
        readonly maxRetries?: number;
      }
    ).maxRetries
  ).toBe(0);
});
