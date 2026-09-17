import { Effect, Layer, Queue, Schema, Semaphore } from "effect";
import {
  MigrationProgress,
  type MigrationProgressEvent,
  RollbackProgress,
  type RollbackProgressEvent,
} from "migrate-sdk/core";
import { getWritable } from "workflow";

export const workflowSdkMigrationProgressStreamNamespace =
  "migrate-sdk-progress";

const Count = Schema.Finite.check(Schema.isInt()).check(
  Schema.isGreaterThanOrEqualTo(0)
);
export const WorkflowSdkMigrationObservationEvent = Schema.Union([
  Schema.Struct({
    counts: Schema.Union([
      Schema.Struct({
        failed: Count,
        migrated: Count,
        needsUpdate: Count,
        skipped: Count,
        unchanged: Count,
        orphaned: Schema.optionalKey(Count),
        rollbackFailed: Schema.optionalKey(Count),
        rolledBack: Schema.optionalKey(Count),
      }),
      Schema.Struct({ failed: Count, rolledBack: Count, skipped: Count }),
    ]),
    definitionId: Schema.NonEmptyString,
    kind: Schema.Literal("progress"),
    runId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    definitionIds: Schema.Array(Schema.NonEmptyString),
    kind: Schema.Literal("state-changed"),
    runId: Schema.NonEmptyString,
  }),
]);
export type WorkflowSdkMigrationObservationEvent =
  typeof WorkflowSdkMigrationObservationEvent.Type;

const publish = (event: WorkflowSdkMigrationObservationEvent) =>
  Effect.acquireUseRelease(
    Effect.try(() =>
      getWritable<WorkflowSdkMigrationObservationEvent>({
        namespace: workflowSdkMigrationProgressStreamNamespace,
      }).getWriter()
    ),
    (writer) =>
      Effect.tryPromise(() => writer.write(event)).pipe(
        Effect.timeout("5 seconds")
      ),
    (writer) => Effect.sync(() => writer.releaseLock())
  ).pipe(Effect.ignore);

// Each step owns its publisher. Item callbacks only replace a pending snapshot;
// a single writer flushes it while the step is still running, and on scope exit.
// Scope exit waits for an in-flight flush; each write has a bounded wait.
export const workflowSdkMigrationProgressLayer = Layer.unwrap(
  Effect.gen(function* () {
    const pending = new Map<string, WorkflowSdkMigrationObservationEvent>();
    const wake = yield* Queue.sliding<void>(1);
    const writer = yield* Semaphore.make(1);
    const flush = Effect.gen(function* () {
      const events = [...pending.values()];
      pending.clear();
      yield* Effect.forEach(events, publish, { discard: true });
    }).pipe(writer.withPermit, Effect.uninterruptible);
    yield* Effect.addFinalizer(() => flush);
    yield* Queue.take(wake).pipe(
      Effect.andThen(Effect.sleep("1 second")),
      Effect.andThen(flush),
      Effect.forever,
      Effect.forkScoped
    );

    const emit = (
      event: MigrationProgressEvent | RollbackProgressEvent
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if ("counts" in event) {
          const key = JSON.stringify([event.runId, event.definitionId]);
          pending.set(key, {
            counts: event.counts,
            definitionId: event.definitionId,
            kind: "progress",
            runId: event.runId,
          });
          if (event.kind === "source-item-completed") {
            yield* Queue.offer(wake, undefined);
          } else {
            yield* flush;
          }
        }
        if (
          event.kind === "source-item-completed" ||
          event.kind === "source-cursor-window-completed" ||
          event.kind === "source-item-total-counted"
        ) {
          return;
        }
        yield* flush;
        yield* publish({
          definitionIds:
            "definitionIds" in event
              ? event.definitionIds
              : [event.definitionId],
          kind: "state-changed",
          runId: event.runId,
        }).pipe(writer.withPermit);
      });

    return Layer.merge(
      Layer.succeed(MigrationProgress, { emit }),
      Layer.succeed(RollbackProgress, { emit })
    );
  })
);
