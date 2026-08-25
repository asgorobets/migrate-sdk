import { Effect } from "effect";
import {
  type ExecutionStartResult,
  type MigrationRunHandleState,
  type MigrationRunTerminalResult,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import {
  type MigrationTuiExecutionState,
  makeMigrationTuiExecutionController,
} from "./execution-controller.ts";

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-tui-test");
const startedAt = new Date("2026-08-22T12:00:00.000Z");
const finishedAt = new Date("2026-08-22T12:00:01.000Z");

interface TestSummary {
  readonly status: "cancelled" | "failed" | "succeeded";
}

const runState = <Status extends "cancelled" | "failed" | "succeeded">(
  status: Status
) => ({
  definitionIds: [definitionId],
  finishedAt,
  runId,
  startedAt,
  status,
});

const waitForState = (
  expected: MigrationTuiExecutionState["kind"],
  states: MigrationTuiExecutionState[]
): Promise<void> =>
  new Promise((resolve) => {
    const interval = setInterval(() => {
      if (states.some((state) => state.kind === expected)) {
        clearInterval(interval);
        resolve();
      }
    }, 1);
  });

describe("Migration TUI execution controller", () => {
  it("publishes execution state independently of a rendered app", async () => {
    const start = Promise.withResolvers<ExecutionStartResult<TestSummary>>();
    const published: Array<MigrationTuiExecutionState | undefined> = [];
    const controller = makeMigrationTuiExecutionController({
      observeDetachedRun: () => Promise.reject(new Error("not detached")),
    });
    const unsubscribe = controller.subscribeExecution((state) => {
      published.push(state);
    });
    const execution = controller.execute({
      definitionId,
      start: () => start.promise,
    });

    expect(controller.getExecutionState()).toEqual({
      definitionId,
      kind: "starting",
    });

    start.resolve({
      kind: "completed",
      runId,
      summary: { status: "succeeded" },
    });

    expect(await execution).toEqual({
      message: `Run ${runId} succeeded`,
      outcome: "completed",
      runId,
    });
    expect(controller.getExecutionState()).toBeUndefined();
    expect(published).toEqual([{ definitionId, kind: "starting" }, undefined]);

    unsubscribe();
  });

  it("requests attached cancellation once and drains to terminal state", async () => {
    const states: MigrationTuiExecutionState[] = [];
    let cancelCalls = 0;
    let finishRun: (result: MigrationRunTerminalResult<TestSummary>) => void =
      () => undefined;
    const wait = new Promise<MigrationRunTerminalResult<TestSummary>>(
      (resolve) => {
        finishRun = resolve;
      }
    );
    const handleState: MigrationRunHandleState = {
      definitionIds: [definitionId],
      runId,
      startedAt,
      status: "cancelling",
    };
    const start: ExecutionStartResult<TestSummary> = {
      execution: { adapter: "inline" },
      handle: {
        cancel: Effect.sync(() => {
          cancelCalls += 1;
          finishRun({ kind: "cancelled", state: runState("cancelled") });
          return handleState;
        }),
        get: Effect.succeed(handleState),
        runId,
        wait: Effect.promise(() => wait),
      },
      kind: "started",
      runId,
    };
    const controller = makeMigrationTuiExecutionController({
      observeDetachedRun: () => Promise.reject(new Error("not detached")),
    });
    const execution = controller.execute({
      definitionId,
      options: {
        onStateChange: (state) => {
          states.push(state);
        },
      },
      start: () => Promise.resolve(start),
    });

    await waitForState("running", states);
    const first = controller.cancelActiveExecution();
    const second = controller.cancelActiveExecution();

    expect((await first).kind).toBe("requested");
    expect((await second).kind).toBe("requested");
    expect(await execution).toEqual({
      message: `Run ${runId} cancelled`,
      outcome: "cancelled",
      runId,
    });
    expect(cancelCalls).toBe(1);
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "running",
      "cancelling",
      "cancelling",
    ]);
    expect(await controller.cancelActiveExecution()).toEqual({ kind: "idle" });
  });

  it("observes a detached execution until durable state is terminal", async () => {
    const states: MigrationTuiExecutionState[] = [];
    const controller = makeMigrationTuiExecutionController({
      observeDetachedRun: ({ execution, runId: observedRunId, signal }) => {
        expect(execution).toEqual({
          adapter: "workflow",
          executionId: "workflow-123",
        });
        expect(observedRunId).toBe(runId);
        expect(signal.aborted).toBe(false);
        return Promise.resolve(runState("succeeded"));
      },
    });

    const result = await controller.execute({
      definitionId,
      options: {
        onStateChange: (state) => {
          states.push(state);
        },
      },
      start: () =>
        Promise.resolve({
          execution: {
            adapter: "workflow" as const,
            executionId: "workflow-123",
          },
          kind: "started" as const,
          runId,
        }),
    });

    expect(result).toEqual({
      message: `Run ${runId} succeeded`,
      outcome: "completed",
      runId,
    });
    expect(states.map((state) => state.kind)).toEqual([
      "starting",
      "observing",
    ]);
  });

  it("reports a durable failed detached execution as failed", async () => {
    const controller = makeMigrationTuiExecutionController({
      observeDetachedRun: () => Promise.resolve(runState("failed")),
    });

    await expect(
      controller.execute({
        definitionId,
        start: () =>
          Promise.resolve({
            execution: {
              adapter: "workflow" as const,
              executionId: "workflow-failed",
            },
            kind: "started" as const,
            runId,
          }),
      })
    ).rejects.toThrow(`Run ${runId} failed`);
  });

  it("stops local observation without claiming to cancel a detached run", async () => {
    const states: MigrationTuiExecutionState[] = [];
    let detached = false;
    const observing = Promise.withResolvers<void>();
    const controller = makeMigrationTuiExecutionController({
      observeDetachedRun: ({ signal }) =>
        new Promise((_, reject) => {
          observing.resolve();
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    const execution = controller.execute({
      definitionId,
      options: {
        onDetached: () => {
          detached = true;
        },
        onStateChange: (state) => {
          states.push(state);
        },
      },
      start: () =>
        Promise.resolve({
          execution: {
            adapter: "workflow" as const,
            executionId: "workflow-123",
          },
          kind: "started" as const,
          runId,
        }),
    });

    await observing.promise;
    const cancellation = await controller.cancelActiveExecution();

    expect(cancellation.kind).toBe("detached");
    expect(await execution).toEqual({
      message: `Run ${runId} continues in the background`,
      outcome: "detached",
      runId,
    });
    expect(detached).toBe(true);
    expect(states.at(-1)?.kind).toBe("cancelling");
  });

  it("honors an exit request made while execution is still starting", async () => {
    const start = Promise.withResolvers<ExecutionStartResult<TestSummary>>();
    let cancelCalls = 0;
    const controller = makeMigrationTuiExecutionController({
      observeDetachedRun: () => Promise.reject(new Error("not detached")),
    });
    const execution = controller.execute({
      definitionId,
      start: () => start.promise,
    });

    const cancellation = await controller.cancelActiveExecution();
    expect(cancellation).toEqual({
      kind: "requested",
      message: "Exit requested; waiting for the run to start…",
    });

    start.resolve({
      execution: { adapter: "inline" },
      handle: {
        cancel: Effect.sync(() => {
          cancelCalls += 1;
          return {
            definitionIds: [definitionId],
            finishedAt,
            runId,
            startedAt,
            status: "cancelled" as const,
          };
        }),
        get: Effect.succeed({
          definitionIds: [definitionId],
          runId,
          startedAt,
          status: "running" as const,
        }),
        runId,
        wait: Effect.succeed({
          kind: "cancelled" as const,
          state: runState("cancelled"),
        }),
      },
      kind: "started",
      runId,
    });

    expect(await execution).toEqual({
      message: `Run ${runId} cancelled`,
      outcome: "cancelled",
      runId,
    });
    expect(cancelCalls).toBe(1);
  });
});
