import { Effect } from "effect";
import {
  type MigrationRunState,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { describe, expect, it } from "vitest";
import { waitForDurableRunState } from "./durable-observation.ts";

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-durable-observation");
const startedAt = new Date("2026-08-22T12:00:00.000Z");
const finishedAt = new Date("2026-08-22T12:00:01.000Z");

const runState = (
  currentRunId: typeof runId,
  status: MigrationRunState["status"]
): MigrationRunState => ({
  definitionIds: [definitionId],
  ...(status === "cancelled" ||
  status === "failed" ||
  status === "start-failed" ||
  status === "succeeded"
    ? { finishedAt }
    : {}),
  runId: currentRunId,
  startedAt,
  status,
});

describe("waitForDurableRunState", () => {
  it("polls until the requested run reaches durable terminal state", async () => {
    const observed = [
      null,
      runState(runId, "queued"),
      runState(runId, "running"),
      runState(runId, "succeeded"),
    ];
    let reads = 0;

    const terminal = await Effect.runPromise(
      waitForDurableRunState({
        pollIntervalMs: 0,
        readRunState: Effect.sync(() => observed[reads++] ?? null),
        runId,
      })
    );

    expect(terminal).toEqual(runState(runId, "succeeded"));
    expect(reads).toBe(4);
  });
});
