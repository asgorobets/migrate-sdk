import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  MigrationItemProgress,
  MigrationProgress,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { beforeEach, vi } from "vitest";
import { workflowSdkMigrationProgressLayer } from "./migration-progress.ts";

const { write } = vi.hoisted(() => ({
  write: vi.fn((_event: unknown): Promise<void> => Promise.resolve()),
}));
vi.mock("workflow", () => ({
  getStepMetadata: () => ({ stepId: "window-a", attempt: 1 }),
  getWritable: () => new WritableStream({ write: (event) => write(event) }),
}));
beforeEach(() => write.mockReset());

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-progress");
const itemCompleted = (_migrated: number) =>
  MigrationItemProgress.emit({
    definitionId,
    runId,
    before: null,
    after: "migrated",
  });
const contribution = (migrated: number, revision: number, failed = 0) => ({
  kind: "contribution",
  runId,
  partitionId: "window-a:1",
  revision,
  changes: [
    { definitionId, delta: { migrated, failed, skipped: 0, needsUpdate: 0 } },
  ],
});

describe("Workflow progress publishing", () => {
  it.effect("keeps nested stub runs separate from the main run", () =>
    Effect.gen(function* () {
      const stubRunId = toMigrationRunId("stub-run");
      const stubId = toMigrationDefinitionId("authors");
      yield* Effect.gen(function* () {
        yield* itemCompleted(1);
        yield* MigrationItemProgress.emit({
          definitionId: stubId,
          runId: stubRunId,
          before: null,
          after: "needs-update",
        });
        yield* itemCompleted(2);
      }).pipe(Effect.provide(workflowSdkMigrationProgressLayer));
      expect(write.mock.calls.map(([event]) => event)).toEqual([
        contribution(2, 1),
        {
          kind: "contribution",
          runId: stubRunId,
          partitionId: "window-a:1",
          revision: 1,
          changes: [
            {
              definitionId: stubId,
              delta: { migrated: 0, failed: 0, skipped: 0, needsUpdate: 1 },
            },
          ],
        },
      ]);
    })
  );

  it.effect(
    "waits for in-flight writes on step exit, bounded even when a writer stalls",
    () =>
      Effect.gen(function* () {
        for (const stalled of [false, true]) {
          const finish = yield* Deferred.make<void>();
          let releaseWrite: () => void = () => undefined;
          const writing = new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
          write.mockImplementationOnce(() => writing);
          let settled = false;
          const step = yield* itemCompleted(1).pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.provide(workflowSdkMigrationProgressLayer),
            Effect.ensuring(
              Effect.sync(() => {
                settled = true;
              })
            ),
            Effect.forkChild
          );
          yield* TestClock.adjust("5 seconds");
          yield* Deferred.succeed(finish, undefined);
          yield* TestClock.adjust(0);
          expect(settled).toBe(false);
          if (stalled) {
            yield* TestClock.adjust("5 seconds");
          } else {
            releaseWrite();
          }
          yield* Fiber.join(step);
          expect(settled).toBe(true);
          releaseWrite();
        }
      })
  );
  it.effect(
    "coalesces items during an unfinished window and flushes the final snapshot on step exit",
    () =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: 100 }, (_, i) => i + 1),
            itemCompleted
          );
          expect(write).not.toHaveBeenCalled();
          yield* TestClock.adjust("5 seconds");
          expect(write).toHaveBeenCalledTimes(1);
          expect(write).toHaveBeenLastCalledWith(contribution(100, 1));
          yield* TestClock.adjust("10 seconds");
          expect(write).toHaveBeenCalledTimes(1);
          yield* itemCompleted(101);
        }).pipe(Effect.provide(workflowSdkMigrationProgressLayer));
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith(contribution(101, 2));
        yield* TestClock.adjust("10 seconds");
        expect(write).toHaveBeenCalledTimes(2);
      })
  );

  it.effect(
    "flushes before lifecycle updates and replaces failed states and removed states correctly",
    () =>
      Effect.gen(function* () {
        yield* MigrationItemProgress.emit({
          definitionId,
          runId,
          before: "failed",
          after: "migrated",
        });
        yield* MigrationProgress.emit({
          definitionIds: [definitionId],
          kind: "run-cancelled",
          runId,
        });
        expect(write.mock.calls.map(([event]) => event)).toEqual([
          contribution(1, 1, -1),
          { definitionIds: [definitionId], kind: "state-changed", runId },
        ]);
        yield* MigrationItemProgress.emit({
          definitionId,
          runId,
          before: "migrated",
          after: null,
        });
        yield* TestClock.adjust("5 seconds");
        expect(write).toHaveBeenLastCalledWith(contribution(0, 2, -1));
      }).pipe(Effect.provide(workflowSdkMigrationProgressLayer))
  );
  it.effect(
    "a later cumulative write repairs a failed publication without repeating item work",
    () =>
      Effect.gen(function* () {
        write.mockRejectedValueOnce(new Error("Stream unavailable"));
        yield* itemCompleted(1);
        yield* TestClock.adjust("5 seconds");
        yield* itemCompleted(2);
        yield* TestClock.adjust("5 seconds");
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith(contribution(2, 2));
      }).pipe(Effect.provide(workflowSdkMigrationProgressLayer))
  );
});
