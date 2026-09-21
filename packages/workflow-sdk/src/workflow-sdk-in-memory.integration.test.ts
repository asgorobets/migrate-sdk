import { Effect, Fiber, Layer, Schema } from "effect";
import {
  type MigrationDefinitionRegistryRunInput,
  type MigrationDefinitionStatus,
  MigrationExecutable,
  type MigrationExecutableObservationEvent,
  MigrationStore,
  makeMigrationItemProgress,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { expect, test } from "vitest";
import { getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import {
  WorkflowSdkMigrationObservationEvent,
  workflowSdkMigrationProgressStreamNamespace,
} from "./migration-progress.ts";
import type { WorkflowStepRetryMetadata } from "./steps.ts";
import {
  beginMigrationRunStep,
  cancelMigrationRunStep,
  completeMigrationRunStep,
  executeMigrationRollbackStep,
  executeMigrationRunCursorWindowStep,
  executeMigrationRunRollbackOrphansPageStep,
  failMigrationRunStep,
  inMemoryMigrationTestProcessConcurrency,
  inMemoryMigrationTestRegistry,
  inMemoryMigrationTestStoreState,
  interruptInMemoryMigrationTestWorkflowAt,
  pauseInMemoryMigrationTestProcessingAfter,
  removeInMemoryMigrationTestSourceItem,
  resetInMemoryMigrationTestState,
  setInMemoryMigrationTestSourceItemCount,
} from "./test-fixtures/in-memory-migration.steps.ts";
import { inMemoryMigrationTestWorkflow } from "./test-fixtures/in-memory-migration.workflow.ts";
import {
  WorkflowSdkClient,
  type WorkflowSdkMigrationWorkflow,
} from "./workflow-sdk-client.ts";
import { WorkflowSdkMigrationExecutable } from "./workflow-sdk-migration-executable.ts";

const runWorkflow: WorkflowSdkMigrationWorkflow = inMemoryMigrationTestWorkflow;

const makeWorkflowSdkMigrationExecutableLayer = (
  workflow: WorkflowSdkMigrationWorkflow
) =>
  WorkflowSdkMigrationExecutable.layer({ workflow }).pipe(
    Layer.provide(WorkflowSdkClient.layer)
  );

const startInMemoryMigrationRun = async (
  rollbackOrphans = false,
  processConcurrency?: number,
  request: Omit<
    MigrationDefinitionRegistryRunInput,
    "definitionIds" | "all" | "group"
  > = {}
) => {
  const plan = await Effect.runPromise(
    inMemoryMigrationTestRegistry.executable().planRun({
      definitionIds: ["articles"],
      ...(processConcurrency === undefined
        ? {}
        : { execution: { process: { concurrency: processConcurrency } } }),
      ...(rollbackOrphans ? { rollbackOrphans: true } : {}),
      ...request,
    })
  );
  const executable = await Effect.runPromise(
    MigrationExecutable.pipe(
      Effect.provide(makeWorkflowSdkMigrationExecutableLayer(runWorkflow))
    )
  );
  const started = await Effect.runPromise(executable.startRun(plan));

  if (started.kind !== "started") {
    throw new Error("Expected Workflow SDK adapter to start the run");
  }

  const executionId = started.execution.executionId;
  if (executionId === undefined) {
    throw new Error("Expected Workflow SDK adapter to attach an execution id");
  }

  return {
    executable,
    run: getRun<Awaited<ReturnType<typeof inMemoryMigrationTestWorkflow>>>(
      executionId
    ),
    started,
  };
};

const readStreamedTotals = async (executionId: string) => {
  const projection = makeMigrationItemProgress();
  let definitions: readonly MigrationDefinitionStatus[] = [];
  const readable = getRun(executionId).getReadable({
    namespace: workflowSdkMigrationProgressStreamNamespace,
    startIndex: 0,
  });
  const tail = await readable.getTailIndex();
  const reader = readable.getReader();
  try {
    for (let index = 0; index <= tail; index += 1) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const event = Schema.decodeUnknownSync(
        WorkflowSdkMigrationObservationEvent
      )(chunk.value);
      if (event.kind !== "state-changed") {
        definitions = projection.apply(event);
      }
    }
    return definitions.map((definition) => definition.durable);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

test("Workflow SDK targets identities and updates unchanged entries in real steps", async () => {
  resetInMemoryMigrationTestState();
  await (await startInMemoryMigrationRun()).run.returnValue;

  const targeted = await startInMemoryMigrationRun(false, undefined, {
    sourceIdentities: ["article-001", "article-003"],
  });
  const targetedResult = await targeted.run.returnValue;
  expect(targetedResult.summary.definitions[0]?.counts).toMatchObject({
    migrated: 2,
    unchanged: 0,
  });
  expect(targetedResult.snapshot.itemStateCount).toBe(100);
  expect(targetedResult.snapshot.definitionLockCount).toBe(0);

  const update = await startInMemoryMigrationRun(false, undefined, {
    update: true,
  });
  const updatedResult = await update.run.returnValue;
  expect(updatedResult.summary.definitions[0]?.counts).toMatchObject({
    migrated: 100,
    unchanged: 0,
  });
  const steps = await getWorld().steps.list({
    resolveData: "none",
    runId: update.run.runId,
  });
  expect(
    steps.data.filter((step) =>
      step.stepName.endsWith("//executeMigrationRunCursorWindowStep")
    )
  ).toHaveLength(2);
  expect(updatedResult.snapshot.definitionLockCount).toBe(0);
  expect(await readStreamedTotals(update.run.runId)).toEqual([
    { migrated: 100, failed: 0, needsUpdate: 0, skipped: 0 },
  ]);

  const normal = await (await startInMemoryMigrationRun()).run.returnValue;
  expect(normal.summary.definitions[0]?.counts).toMatchObject({
    migrated: 0,
    unchanged: 100,
  });
});

test("Workflow SDK resumes persisted update backlog after a step fails", async () => {
  resetInMemoryMigrationTestState();
  await (await startInMemoryMigrationRun()).run.returnValue;
  interruptInMemoryMigrationTestWorkflowAt("after-source-window");
  const update = await startInMemoryMigrationRun(false, undefined, {
    update: true,
  });
  await expect(update.run.returnValue).rejects.toThrow();
  expect(inMemoryMigrationTestStoreState.definitionLocks.size).toBe(0);
  expect(
    [...inMemoryMigrationTestStoreState.itemStates.values()].filter(
      (item) => item.status === "needs-update"
    )
  ).toHaveLength(50);
  const resumed = await (await startInMemoryMigrationRun()).run.returnValue;
  expect(resumed.summary.definitions[0]?.counts).toMatchObject({
    migrated: 50,
    failed: 0,
  });
  expect(resumed.snapshot.migratedItemStateCount).toBe(100);
  expect(resumed.snapshot.definitionLockCount).toBe(0);
});

test("Workflow SDK executes a real in-memory migration run and rollback", async () => {
  resetInMemoryMigrationTestState();

  const plan = await Effect.runPromise(
    inMemoryMigrationTestRegistry.executable().planRun({
      definitionIds: ["articles"],
    })
  );
  const started = await Effect.runPromise(
    MigrationExecutable.startRun(plan).pipe(
      Effect.provide(makeWorkflowSdkMigrationExecutableLayer(runWorkflow))
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
    rollbackCallCount: 0,
    sourceCursorCommitCount: 1,
  });
  expect(cursorWindowSteps).toHaveLength(2);
  expect(cursorWindowSteps.map((step) => step.status)).toEqual([
    "completed",
    "completed",
  ]);
  const migrationExecutionSteps = [
    beginMigrationRunStep,
    cancelMigrationRunStep,
    executeMigrationRunCursorWindowStep,
    executeMigrationRunRollbackOrphansPageStep,
    completeMigrationRunStep,
    failMigrationRunStep,
  ] as readonly (typeof beginMigrationRunStep &
    Partial<WorkflowStepRetryMetadata>)[];
  expect(migrationExecutionSteps.map((step) => step.maxRetries)).toEqual([
    undefined,
    undefined,
    0,
    0,
    undefined,
    undefined,
  ]);

  removeInMemoryMigrationTestSourceItem("article-100");
  const rollbackOrphansPlan = await Effect.runPromise(
    inMemoryMigrationTestRegistry.executable().planRun({
      definitionIds: ["articles"],
      rollbackOrphans: true,
    })
  );
  const rollbackOrphansStarted = await Effect.runPromise(
    MigrationExecutable.startRun(rollbackOrphansPlan).pipe(
      Effect.provide(makeWorkflowSdkMigrationExecutableLayer(runWorkflow))
    )
  );

  expect(rollbackOrphansStarted.kind).toBe("started");
  if (rollbackOrphansStarted.kind !== "started") {
    throw new Error("Expected Workflow SDK adapter to start Rollback Orphans");
  }

  const rollbackOrphansRun = getRun<
    Awaited<ReturnType<typeof inMemoryMigrationTestWorkflow>>
  >(rollbackOrphansStarted.execution.executionId as string);
  const rollbackOrphansResult = await rollbackOrphansRun.returnValue;
  expect(await readStreamedTotals(rollbackOrphansRun.runId)).toEqual([
    { migrated: 99, failed: 0, needsUpdate: 0, skipped: 0 },
  ]);
  const rollbackOrphansSteps = await getWorld().steps.list({
    resolveData: "none",
    runId: rollbackOrphansRun.runId,
  });

  expect(rollbackOrphansResult.summary).toEqual(
    expect.objectContaining({
      definitions: [
        {
          counts: {
            failed: 0,
            migrated: 0,
            needsUpdate: 0,
            orphaned: 1,
            rollbackFailed: 0,
            rolledBack: 1,
            skipped: 0,
            unchanged: 99,
          },
          definitionId: "articles",
          status: "succeeded",
        },
      ],
      status: "succeeded",
    })
  );
  expect(rollbackOrphansResult.snapshot).toEqual({
    definitionLockCount: 0,
    itemStateCount: 99,
    latestRunStatus: "succeeded",
    migratedItemStateCount: 99,
    rollbackCallCount: 1,
    sourceCursorCommitCount: 2,
  });
  expect(
    rollbackOrphansSteps.data.filter((step) =>
      step.stepName.endsWith("//executeMigrationRunRollbackOrphansPageStep")
    )
  ).toHaveLength(1);

  const rollbackPlan = await Effect.runPromise(
    inMemoryMigrationTestRegistry.executable().planRollback({
      definitionIds: ["articles"],
    })
  );
  const rollbackStarted = await Effect.runPromise(
    MigrationExecutable.startRollback(rollbackPlan).pipe(
      Effect.provide(makeWorkflowSdkMigrationExecutableLayer(runWorkflow))
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
    getRun<Awaited<ReturnType<typeof inMemoryMigrationTestWorkflow>>>(
      rollbackExecutionId
    );
  const rollbackResult = await rollbackRun.returnValue;
  expect(await readStreamedTotals(rollbackRun.runId)).toEqual([
    { migrated: 0, failed: 0, needsUpdate: 0, skipped: 0 },
  ]);
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
            rolledBack: 99,
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
    rollbackCallCount: 100,
    sourceCursorCommitCount: 2,
  });
  expect(rollbackExecutionSteps).toHaveLength(1);
  expect(rollbackExecutionSteps.map((step) => step.status)).toEqual([
    "completed",
  ]);
  expect(
    (
      executeMigrationRollbackStep as typeof executeMigrationRollbackStep &
        Partial<WorkflowStepRetryMetadata>
    ).maxRetries
  ).toBeUndefined();
});

test("Workflow SDK applies planned Process Pipeline concurrency inside cursor-window steps", async () => {
  resetInMemoryMigrationTestState();
  const execution = await startInMemoryMigrationRun(false, 3);

  await execution.run.returnValue;

  expect(inMemoryMigrationTestProcessConcurrency()).toBe(3);
});

test("Workflow SDK observes a durable cancellation request between cursor-window steps", async () => {
  resetInMemoryMigrationTestState();
  setInMemoryMigrationTestSourceItemCount(1000);
  const execution = await startInMemoryMigrationRun();
  const store = await Effect.runPromise(
    MigrationStore.pipe(
      Effect.provide(
        InMemoryMigrationStore.layer(inMemoryMigrationTestStoreState)
      )
    )
  );

  const requested = await Effect.runPromise(
    store.requestRunCancellation(execution.started.runId, [
      toMigrationDefinitionId("articles"),
    ])
  );

  expect(requested.status).toBe("cancelling");
  const result = await execution.run.returnValue;

  expect(result.summary.status).toBe("cancelled");
  expect(result.snapshot.latestRunStatus).toBe("cancelled");
  expect(await execution.run.status).toBe("completed");
  expect(
    inMemoryMigrationTestStoreState.runStates.get(execution.started.runId)
      ?.status
  ).toBe("cancelled");
  expect(inMemoryMigrationTestStoreState.definitionLocks.size).toBe(0);
  expect(inMemoryMigrationTestStoreState.itemStates.size).toBeLessThan(1000);
});

test("Workflow SDK streams unfinished work and resumes from the last delivered event", async () => {
  resetInMemoryMigrationTestState();
  const resume = pauseInMemoryMigrationTestProcessingAfter(10);
  const execution = await startInMemoryMigrationRun(false, 1);
  const events: MigrationExecutableObservationEvent[] = [];
  let receivedProgress: () => void = () => undefined;
  const liveProgress = new Promise<void>((resolve) => {
    receivedProgress = resolve;
  });
  const waitForExecution = execution.executable.waitForExecution;
  if (waitForExecution === undefined) {
    throw new Error("Expected Workflow observation");
  }
  const observe = (after?: string) =>
    waitForExecution(
      {
        adapter: execution.started.execution.adapter,
        executionId: execution.run.runId,
      },
      {
        ...(after === undefined ? {} : { after }),
        onEvent: (event) =>
          Effect.sync(() => {
            events.push(event);
            if (
              event.kind === "progress" &&
              event.progress.kind === "snapshot"
            ) {
              receivedProgress();
            }
          }),
      }
    );
  let observer = Effect.runFork(observe());
  let receivedBeforeDetach = 0;
  let lastCursor = "";
  try {
    await Promise.race([
      liveProgress,
      Effect.runPromise(Fiber.await(observer)).then(() => {
        throw new Error("Execution finished before live progress");
      }),
    ]);
    const projection = makeMigrationItemProgress();
    let statuses: MigrationDefinitionStatus[] = [];
    for (const event of events) {
      if (event.kind === "progress") {
        statuses = [...projection.apply(event.progress)];
      }
    }
    expect(statuses).toMatchObject([{ durable: { migrated: 10, failed: 0 } }]);
    expect(inMemoryMigrationTestStoreState.sourceCursorCommits).toHaveLength(0);
    expect(inMemoryMigrationTestStoreState.itemStates.size).toBe(10);
    expect(await execution.run.status).toBe("running");
    await Effect.runPromise(Fiber.interrupt(observer));
    expect(await execution.run.status).toBe("running");
    receivedBeforeDetach = events.length;
    const cursor = events.at(-1)?.cursor;
    if (cursor === undefined) {
      throw new Error("Expected a resumable progress event");
    }
    lastCursor = cursor;
    observer = Effect.runFork(observe(lastCursor));
    resume();
    expect(await Effect.runPromise(Fiber.join(observer))).toEqual({
      kind: "succeeded",
      summary: expect.objectContaining({
        runId: execution.started.runId,
        status: "succeeded",
      }),
    });
  } finally {
    resume();
    await Effect.runPromise(Fiber.interrupt(observer));
  }
  const resumed = events.slice(receivedBeforeDetach);
  expect(resumed.length).toBeGreaterThan(0);
  expect(resumed.map((event) => event.cursor)).toEqual(
    resumed.map((_, index) => String(Number(lastCursor) + index + 1))
  );
  const projection = makeMigrationItemProgress();
  let statuses: MigrationDefinitionStatus[] = [];
  for (const event of events) {
    if (event.kind === "progress") {
      statuses = [...projection.apply(event.progress)];
    }
  }
  expect(statuses).toMatchObject([{ durable: { migrated: 100, failed: 0 } }]);
  expect(events).toContainEqual(
    expect.objectContaining({
      definitionIds: ["articles"],
      kind: "state-changed",
      runId: execution.started.runId,
    })
  );
  const progressStream = execution.run.getReadable({
    namespace: workflowSdkMigrationProgressStreamNamespace,
  });
  expect(await progressStream.getTailIndex()).toBeGreaterThan(1);
});

test("Workflow SDK restarts Rollback Orphans from the beginning after interruption between source windows", async () => {
  resetInMemoryMigrationTestState();
  const seeded = await startInMemoryMigrationRun();
  await seeded.run.returnValue;

  removeInMemoryMigrationTestSourceItem("article-100");
  interruptInMemoryMigrationTestWorkflowAt("after-source-window");
  const interrupted = await startInMemoryMigrationRun(true);

  await expect(interrupted.run.returnValue).rejects.toThrow(
    "Interrupted in-memory workflow after-source-window"
  );
  expect(await interrupted.run.status).toBe("failed");
  expect(inMemoryMigrationTestStoreState.definitionLocks.size).toBe(0);
  expect(inMemoryMigrationTestStoreState.itemStates.size).toBe(100);
  const interruptedSteps = await getWorld().steps.list({
    resolveData: "none",
    runId: interrupted.run.runId,
  });
  expect(
    interruptedSteps.data
      .filter((step) =>
        step.stepName.endsWith("//executeMigrationRunCursorWindowStep")
      )
      .map((step) => step.status)
  ).toEqual(["failed"]);

  const restarted = await startInMemoryMigrationRun(true);
  const restartedResult = await restarted.run.returnValue;

  expect(restartedResult.summary.definitions[0]?.counts).toEqual({
    failed: 0,
    migrated: 0,
    needsUpdate: 0,
    orphaned: 1,
    rollbackFailed: 0,
    rolledBack: 1,
    skipped: 0,
    unchanged: 99,
  });
  expect(restartedResult.snapshot).toEqual({
    definitionLockCount: 0,
    itemStateCount: 99,
    latestRunStatus: "succeeded",
    migratedItemStateCount: 99,
    rollbackCallCount: 1,
    sourceCursorCommitCount: 3,
  });
});

test("Workflow SDK does not roll back orphans when interrupted between scan and rollback", async () => {
  resetInMemoryMigrationTestState();
  const seeded = await startInMemoryMigrationRun();
  await seeded.run.returnValue;

  removeInMemoryMigrationTestSourceItem("article-100");
  interruptInMemoryMigrationTestWorkflowAt("before-rollback-orphans");
  const interrupted = await startInMemoryMigrationRun(true);

  await expect(interrupted.run.returnValue).rejects.toThrow(
    "Interrupted in-memory workflow before-rollback-orphans"
  );
  expect(await interrupted.run.status).toBe("failed");
  expect(inMemoryMigrationTestStoreState.definitionLocks.size).toBe(0);
  expect(inMemoryMigrationTestStoreState.itemStates.size).toBe(100);
  const interruptedSteps = await getWorld().steps.list({
    resolveData: "none",
    runId: interrupted.run.runId,
  });
  expect(
    interruptedSteps.data
      .filter((step) =>
        step.stepName.endsWith("//executeMigrationRunRollbackOrphansPageStep")
      )
      .map((step) => step.status)
  ).toEqual(["failed"]);

  const restarted = await startInMemoryMigrationRun(true);
  const restartedResult = await restarted.run.returnValue;

  expect(restartedResult.summary.definitions[0]?.counts).toEqual({
    failed: 0,
    migrated: 0,
    needsUpdate: 0,
    orphaned: 1,
    rollbackFailed: 0,
    rolledBack: 1,
    skipped: 0,
    unchanged: 99,
  });
  expect(restartedResult.snapshot.rollbackCallCount).toBe(1);
  expect(restartedResult.snapshot.itemStateCount).toBe(99);
});

test("Workflow SDK keeps successful orphan deletions when interrupted between rollback pages", async () => {
  resetInMemoryMigrationTestState();
  setInMemoryMigrationTestSourceItemCount(101);
  const seeded = await startInMemoryMigrationRun();
  await seeded.run.returnValue;

  setInMemoryMigrationTestSourceItemCount(0);
  interruptInMemoryMigrationTestWorkflowAt("after-rollback-orphans-page");
  const interrupted = await startInMemoryMigrationRun(true);

  await expect(interrupted.run.returnValue).rejects.toThrow(
    "Interrupted in-memory workflow after-rollback-orphans-page"
  );
  expect(await interrupted.run.status).toBe("failed");
  expect(inMemoryMigrationTestStoreState.definitionLocks.size).toBe(0);
  expect(inMemoryMigrationTestStoreState.itemStates.size).toBe(1);
  const interruptedSteps = await getWorld().steps.list({
    resolveData: "none",
    runId: interrupted.run.runId,
  });
  expect(
    interruptedSteps.data
      .filter((step) =>
        step.stepName.endsWith("//executeMigrationRunRollbackOrphansPageStep")
      )
      .map((step) => step.status)
  ).toEqual(["failed"]);

  const restarted = await startInMemoryMigrationRun(true);
  const restartedResult = await restarted.run.returnValue;

  expect(restartedResult.summary.definitions[0]?.counts).toEqual({
    failed: 0,
    migrated: 0,
    needsUpdate: 0,
    orphaned: 1,
    rollbackFailed: 0,
    rolledBack: 1,
    skipped: 0,
    unchanged: 0,
  });
  expect(restartedResult.snapshot).toEqual({
    definitionLockCount: 0,
    itemStateCount: 0,
    latestRunStatus: "succeeded",
    migratedItemStateCount: 0,
    rollbackCallCount: 101,
    sourceCursorCommitCount: 2,
  });
});
