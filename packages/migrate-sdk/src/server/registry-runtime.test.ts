import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Schema } from "effect";
import {
  emptyMigrationProgressCounts,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  MigrationStore,
  MigrationStoreError,
  Source,
  SourceIdentity,
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
    "validates requested definitions before counting a source or acquiring its store",
    () => {
      const definitionId = toMigrationDefinitionId("articles");
      const missingDefinitionId = toMigrationDefinitionId("missing");
      let countAttempts = 0;
      const identity = SourceIdentity.make({
        id: "registry-server-article@v1",
        schema: SourceIdentity.key("id", Schema.NonEmptyString),
      });
      const definition = MigrationDefinition.make({
        id: definitionId,
        process: () => Effect.void,
        source: Source.make({
          countTotal: () =>
            Effect.sync(() => {
              countAttempts += 1;
              return 2;
            }),
          cursorSchema: Schema.Struct({ offset: Schema.Int }),
          identity,
          lookupStrategy: "direct",
          read: () => Effect.succeed({ items: [] }),
          readByIdentity: () => Effect.succeed(null),
          sourceSchema: Schema.Struct({ title: Schema.String }),
        }),
        store: Layer.effect(
          MigrationStore,
          Effect.fail(
            new MigrationStoreError({ message: "Store must not be acquired" })
          )
        ),
      });
      const runtime = makeRegistryMigrateServerRuntime({
        executable: MigrationExecutable.inlineService,
        registry: MigrationDefinitionRegistry.make({
          definitions: [definition],
        }),
      });

      return Effect.gen(function* () {
        expect(
          yield* runtime.getSourceItemTotals([definitionId, definitionId])
        ).toEqual([{ definitionId, total: { count: 2, kind: "known" } }]);
        expect(countAttempts).toBe(1);

        const error = yield* runtime
          .getSourceItemTotals([definitionId, missingDefinitionId])
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          message: `Migration was not found: ${missingDefinitionId}`,
        });
        expect(countAttempts).toBe(1);
      });
    }
  );

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
