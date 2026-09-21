import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  type MigrationRunState,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "../index.ts";
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
  it.effect(
    "backs off quiet durable reads and stops reading after detach",
    () =>
      Effect.gen(function* () {
        const firstRead = yield* Deferred.make<void>();
        let reads = 0;
        const observer = yield* waitForDurableRunState({
          pollIntervalMs: 500,
          maxPollIntervalMs: 5000,
          readRunState: Effect.sync(() => {
            reads += 1;
            Deferred.doneUnsafe(firstRead, Effect.void);
            return runState(runId, "running");
          }),
          runId,
        }).pipe(Effect.forkChild);
        yield* Deferred.await(firstRead);
        yield* TestClock.adjust("20 seconds");
        // Reads at 0, .5, 1.5, 3.5, 7.5, 12.5, and 17.5 seconds.
        expect(reads).toBe(7);
        yield* Fiber.interrupt(observer);
        yield* TestClock.adjust("20 seconds");
        expect(reads).toBe(7);
      })
  );
  it.effect(
    "polls until the requested run reaches durable terminal state",
    () =>
      Effect.gen(function* () {
        const observed = [
          null,
          runState(runId, "queued"),
          runState(runId, "running"),
          runState(runId, "succeeded"),
        ];
        let reads = 0;

        const terminal = yield* waitForDurableRunState({
          pollIntervalMs: 0,
          readRunState: Effect.sync(() => observed[reads++] ?? null),
          runId,
        });

        expect(terminal).toEqual(runState(runId, "succeeded"));
        expect(reads).toBe(4);
      })
  );
});
