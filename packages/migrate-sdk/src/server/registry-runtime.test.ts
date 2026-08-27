import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue } from "effect";
import {
  emptyMigrationProgressCounts,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "../index.ts";
import { makeRegistryMigrateServerRuntime } from "./registry-runtime.ts";

describe("registry migration server runtime", () => {
  it("constructs directly from an existing registry", () => {
    const runtime = makeRegistryMigrateServerRuntime({
      executable: MigrationExecutable.inlineService,
      registry: MigrationDefinitionRegistry.make({ definitions: [] }),
    });

    expect(runtime.rows).toEqual([]);
    expect(runtime.groups).toEqual([]);
  });

  it.effect(
    "uses provider checkpoints as dashboard invalidations without reading a migration store",
    () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("articles");
        const runId = toMigrationRunId("run-1");
        const futureCheckpoint = yield* Deferred.make<void>();
        const invalidations = yield* Queue.unbounded<void>();
        const runtime = makeRegistryMigrateServerRuntime({
          executable: {
            ...MigrationExecutable.inlineService,
            waitForExecution: (_execution, options) =>
              Effect.gen(function* () {
                const checkpoint = {
                  counts: emptyMigrationProgressCounts,
                  definitionId,
                  kind: "source-cursor-window-completed",
                  runId,
                } as const;
                yield* options?.onProgressCheckpoint?.(checkpoint) ??
                  Effect.void;
                yield* Deferred.await(futureCheckpoint);
                yield* options?.onProgressCheckpoint?.(checkpoint) ??
                  Effect.void;
                return yield* Effect.never;
              }),
          },
          registry: MigrationDefinitionRegistry.make({ definitions: [] }),
        });
        const watcher = yield* runtime
          .watchDashboardRun(
            {
              definitionIds: [definitionId],
              execution: {
                adapter: "workflow-sdk",
                executionId: "workflow-run-1",
              },
              observationDefinitionId: definitionId,
              runId,
              startedAt: new Date("2026-08-26T12:00:00.000Z"),
              status: "running",
              stopSupported: false,
            },
            Queue.offer(invalidations, undefined).pipe(Effect.asVoid)
          )
          .pipe(Effect.forkChild);

        yield* Queue.take(invalidations);
        yield* Deferred.succeed(futureCheckpoint, undefined);
        yield* Queue.take(invalidations);
        yield* Fiber.interrupt(watcher);
      })
  );
});
