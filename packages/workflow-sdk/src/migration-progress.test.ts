import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  emptyMigrationProgressCounts,
  MigrationProgress,
  RollbackProgress,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { beforeEach, vi } from "vitest";
import { workflowSdkMigrationProgressLayer } from "./migration-progress.ts";

const { write } = vi.hoisted(() => ({
  write: vi.fn((_event: unknown): Promise<void> => Promise.resolve()),
}));
vi.mock("workflow", () => ({
  getWritable: () => new WritableStream({ write: (event) => write(event) }),
}));
beforeEach(() => write.mockReset());

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-progress");
const itemCompleted = (migrated: number) =>
  MigrationProgress.emit({
    counts: { ...emptyMigrationProgressCounts, migrated },
    definitionId,
    kind: "source-item-completed",
    outcome: "migrated",
    runId,
  });

describe("Workflow progress publishing", () => {
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
          yield* TestClock.adjust("1 second");
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
          yield* TestClock.adjust("1 second");
          expect(write).toHaveBeenCalledTimes(1);
          expect(write).toHaveBeenLastCalledWith({
            counts: { ...emptyMigrationProgressCounts, migrated: 100 },
            definitionId,
            kind: "progress",
            runId,
          });
          yield* TestClock.adjust("10 seconds");
          expect(write).toHaveBeenCalledTimes(1);
          yield* itemCompleted(101);
        }).pipe(Effect.provide(workflowSdkMigrationProgressLayer));
        expect(write).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenLastCalledWith(
          expect.objectContaining({
            counts: { ...emptyMigrationProgressCounts, migrated: 101 },
          })
        );
        yield* TestClock.adjust("10 seconds");
        expect(write).toHaveBeenCalledTimes(2);
      })
  );

  it.effect(
    "flushes pending progress before lifecycle updates and supports rollback counts",
    () =>
      Effect.gen(function* () {
        yield* itemCompleted(1);
        yield* MigrationProgress.emit({
          definitionIds: [definitionId],
          kind: "run-cancelled",
          runId,
        });
        expect(write.mock.calls.map(([event]) => event)).toEqual([
          {
            counts: { ...emptyMigrationProgressCounts, migrated: 1 },
            definitionId,
            kind: "progress",
            runId,
          },
          { definitionIds: [definitionId], kind: "state-changed", runId },
        ]);
        yield* RollbackProgress.emit({
          counts: { failed: 0, rolledBack: 2, skipped: 0 },
          definitionId,
          kind: "source-item-completed",
          outcome: "rolled-back",
          runId,
        });
        yield* TestClock.adjust("1 second");
        expect(write).toHaveBeenLastCalledWith({
          counts: { failed: 0, rolledBack: 2, skipped: 0 },
          definitionId,
          kind: "progress",
          runId,
        });
      }).pipe(Effect.provide(workflowSdkMigrationProgressLayer))
  );

  it.effect(
    "isolates definitions and keeps execution working after a stream write fails",
    () =>
      Effect.gen(function* () {
        write.mockRejectedValueOnce(new Error("Stream unavailable"));
        yield* itemCompleted(1);
        yield* TestClock.adjust("1 second");
        yield* itemCompleted(2);
        yield* MigrationProgress.emit({
          counts: { ...emptyMigrationProgressCounts, migrated: 3 },
          definitionId: toMigrationDefinitionId("products"),
          kind: "source-item-completed",
          outcome: "migrated",
          runId,
        });
        yield* TestClock.adjust("1 second");
        expect(write).toHaveBeenCalledTimes(3);
        expect(write.mock.calls.slice(1).map(([event]) => event)).toEqual([
          {
            counts: { ...emptyMigrationProgressCounts, migrated: 2 },
            definitionId,
            kind: "progress",
            runId,
          },
          {
            counts: { ...emptyMigrationProgressCounts, migrated: 3 },
            definitionId: "products",
            kind: "progress",
            runId,
          },
        ]);
      }).pipe(Effect.provide(workflowSdkMigrationProgressLayer))
  );
});
