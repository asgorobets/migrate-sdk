import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  MigrationDefinition,
  MigrationItemProgress,
  MigrationProgress,
  MigrationRuntimeError,
  MigrationStore,
  makeMigrationItemProgress,
  SourceIdentity,
  skipItem,
  toMigrationDefinitionId,
  toMigrationRunId,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { runInlineRegistry } from "migrate-sdk/testing";
import {
  WorkflowProgressStream,
  type WorkflowSdkMigrationObservationEvent,
  workflowSdkMigrationProgressLayer,
} from "./migration-progress.ts";

const recordProgress = (
  write: (
    event: WorkflowSdkMigrationObservationEvent
  ) => Effect.Effect<void, Cause.UnknownError> = () => Effect.void
) => {
  const events: WorkflowSdkMigrationObservationEvent[] = [];
  const stream = Layer.succeed(WorkflowProgressStream, {
    partitionId: "window-a:1",
    write: (event) =>
      write(event).pipe(
        Effect.andThen(
          Effect.sync(() => {
            events.push(event);
          })
        )
      ),
  });
  return {
    events,
    layer: workflowSdkMigrationProgressLayer.pipe(Layer.provide(stream)),
  };
};

const definitionId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-progress");
const itemCompleted = MigrationItemProgress.emit({
  definitionId,
  runId,
  before: null,
  after: "migrated",
});
const snapshot = (migrated: number, revision: number, failed = 0) => ({
  kind: "snapshot",
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
      const progress = recordProgress();
      const stubRunId = toMigrationRunId("stub-run");
      const stubId = toMigrationDefinitionId("authors");
      yield* Effect.gen(function* () {
        yield* itemCompleted;
        yield* MigrationItemProgress.emit({
          definitionId: stubId,
          runId: stubRunId,
          before: null,
          after: "needs-update",
        });
        yield* itemCompleted;
      }).pipe(Effect.provide(progress.layer));
      expect(progress.events).toEqual([
        snapshot(2, 1),
        {
          kind: "snapshot",
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
          const writeStarted = yield* Deferred.make<void>();
          const writeFinished = yield* Deferred.make<void>();
          const progress = recordProgress(() =>
            Deferred.succeed(writeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(writeFinished))
            )
          );
          let settled = false;
          const step = yield* itemCompleted.pipe(
            Effect.andThen(Deferred.await(finish)),
            Effect.provide(progress.layer),
            Effect.ensuring(
              Effect.sync(() => {
                settled = true;
              })
            ),
            Effect.forkChild
          );
          yield* TestClock.adjust("5 seconds");
          yield* Deferred.await(writeStarted);
          expect(progress.events).toEqual([]);
          yield* Deferred.succeed(finish, undefined);
          yield* TestClock.adjust(0);
          expect(settled).toBe(false);
          if (stalled) {
            yield* TestClock.adjust("5 seconds");
          } else {
            yield* Deferred.succeed(writeFinished, undefined);
          }
          yield* Fiber.join(step);
          expect(settled).toBe(true);
          expect(progress.events).toEqual(stalled ? [] : [snapshot(1, 1)]);
        }
      })
  );
  it.effect(
    "batches items during an unfinished window and flushes the final snapshot on step exit",
    () =>
      Effect.gen(function* () {
        const progress = recordProgress();
        yield* Effect.gen(function* () {
          yield* Effect.forEach(
            Array.from({ length: 100 }),
            () => itemCompleted
          );
          expect(progress.events).toEqual([]);
          yield* TestClock.adjust("5 seconds");
          expect(progress.events).toEqual([snapshot(100, 1)]);
          yield* TestClock.adjust("10 seconds");
          expect(progress.events).toHaveLength(1);
          yield* itemCompleted;
        }).pipe(Effect.provide(progress.layer));
        expect(progress.events).toEqual([snapshot(100, 1), snapshot(101, 2)]);
        yield* TestClock.adjust("10 seconds");
        expect(progress.events).toHaveLength(2);
      })
  );

  it.effect(
    "flushes before lifecycle updates and replaces failed states and removed states correctly",
    () =>
      Effect.gen(function* () {
        const progress = recordProgress();
        yield* Effect.gen(function* () {
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
          expect(progress.events).toEqual([
            snapshot(1, 1, -1),
            { definitionIds: [definitionId], kind: "state-changed", runId },
          ]);
          yield* MigrationItemProgress.emit({
            definitionId,
            runId,
            before: "migrated",
            after: null,
          });
          yield* TestClock.adjust("5 seconds");
          expect(progress.events.at(-1)).toEqual(snapshot(0, 2, -1));
        }).pipe(Effect.provide(progress.layer));
      })
  );
  it.effect(
    "a reader recovers the total from the next successful publication",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        const progress = recordProgress(() => {
          attempts += 1;
          return attempts === 1
            ? Effect.fail(new Cause.UnknownError("Stream unavailable"))
            : Effect.void;
        });
        yield* Effect.gen(function* () {
          yield* itemCompleted;
          yield* TestClock.adjust("5 seconds");
          expect(progress.events).toEqual([]);
          yield* itemCompleted;
          yield* TestClock.adjust("5 seconds");
          const reader = makeMigrationItemProgress();
          let statuses = reader.apply({
            kind: "baseline",
            runId,
            definitions: [
              {
                definitionId,
                discovery: "incremental",
                durable: { migrated: 0, failed: 0, skipped: 0, needsUpdate: 0 },
                lastRun: null,
                lock: null,
                warnings: [],
              },
            ],
          });
          for (const event of progress.events) {
            if (event.kind !== "state-changed") {
              statuses = reader.apply(event);
            }
          }
          expect(statuses[0]?.durable).toEqual({
            migrated: 2,
            failed: 0,
            skipped: 0,
            needsUpdate: 0,
          });
          expect(progress.events).toHaveLength(1);
        }).pipe(Effect.provide(progress.layer));
      })
  );
  it.effect(
    "streams stored totals when items fail, skip, recover, and fail an update",
    () =>
      Effect.gen(function* () {
        const storeLayer = InMemoryMigrationStore.layer(
          InMemoryMigrationStore.makeState()
        );
        const store = yield* MigrationStore.pipe(Effect.provide(storeLayer));
        let rejectItems = true;
        const definition = MigrationDefinition.make({
          id: definitionId,
          store: storeLayer,
          source: InMemorySource.make({
            identity: SourceIdentity.make({
              id: "progress-items@v1",
              schema: SourceIdentity.key("id", Schema.NonEmptyString),
            }),
            sourceSchema: Schema.String,
            items: ["fails", "skips"].map((id) => ({
              identityKey: id,
              item: id,
              version: "v1",
            })),
          }),
          process: (source) =>
            Effect.gen(function* () {
              if (!rejectItems) {
                return;
              }
              if (source.item === "fails") {
                return yield* new MigrationRuntimeError({
                  message: "Rejected item",
                });
              }
              return skipItem("Not eligible");
            }),
        });
        const run = (update = false) =>
          Effect.gen(function* () {
            const before = yield* store.getItemStateSummary(definitionId);
            const progress = recordProgress();
            const summary = yield* runInlineRegistry({
              definitions: [definition],
              definitionIds: [definitionId],
              ...(update
                ? { update: true }
                : { sourceIdentities: ["fails", "skips"] }),
            }).pipe(Effect.provide(progress.layer));
            const reader = makeMigrationItemProgress();
            let statuses = reader.apply({
              kind: "baseline",
              runId: summary.runId,
              definitions: [
                {
                  definitionId,
                  discovery: "full",
                  durable: before,
                  lastRun: null,
                  lock: null,
                  warnings: [],
                },
              ],
            });
            for (const event of progress.events) {
              if (event.kind !== "state-changed") {
                statuses = reader.apply(event);
              }
            }
            const stored = yield* store.getItemStateSummary(definitionId);
            expect(statuses[0]?.durable).toEqual(stored);
            return stored;
          });
        const rejected = { migrated: 0, failed: 1, skipped: 1, needsUpdate: 0 };
        expect(yield* run()).toEqual(rejected);
        rejectItems = false;
        expect(yield* run()).toEqual({
          migrated: 2,
          failed: 0,
          skipped: 0,
          needsUpdate: 0,
        });
        rejectItems = true;
        expect(yield* run(true)).toEqual(rejected);
      })
  );
});
