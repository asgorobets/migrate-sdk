import { Effect, Layer, Queue, Schema, Semaphore } from "effect";
import type { MigrationRunId } from "migrate-sdk";
import {
  type MigrationDefinitionId,
  MigrationItemProgress,
  MigrationItemProgressUpdate,
  type MigrationItemStateDelta,
  MigrationProgress,
  type MigrationProgressEvent,
  RollbackProgress,
  type RollbackProgressEvent,
} from "migrate-sdk/core";
import { getStepMetadata, getWritable } from "workflow";

export const workflowSdkMigrationProgressStreamNamespace =
  "migrate-sdk-progress";
export const WorkflowSdkMigrationObservationEvent = Schema.Union([
  MigrationItemProgressUpdate,
  Schema.Struct({
    definitionIds: Schema.Array(Schema.NonEmptyString),
    kind: Schema.Literal("state-changed"),
    runId: Schema.NonEmptyString,
  }),
]);
export type WorkflowSdkMigrationObservationEvent =
  typeof WorkflowSdkMigrationObservationEvent.Type;

export const writeWorkflowProgress = (
  event: WorkflowSdkMigrationObservationEvent
) =>
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
  );

export const publishWorkflowProgress = (
  event: WorkflowSdkMigrationObservationEvent
) => writeWorkflowProgress(event).pipe(Effect.ignore);

// One small cumulative contribution per active step every five seconds, plus
// step exit. No per-item persistence and no writes while nothing changes.
export const workflowSdkMigrationProgressLayer = Layer.unwrap(
  Effect.gen(function* () {
    const metadata = yield* Effect.try(getStepMetadata).pipe(Effect.option);
    // Direct, non-Workflow invocation is useful in tests and follows the same scope.
    const partitionId =
      metadata._tag === "Some"
        ? `${metadata.value.stepId}:${metadata.value.attempt}`
        : crypto.randomUUID();
    const runs = new Map<
      MigrationRunId,
      {
        changes: Map<MigrationDefinitionId, MigrationItemStateDelta>;
        revision: number;
        dirty: boolean;
      }
    >();
    const wake = yield* Queue.sliding<void>(1);
    const writer = yield* Semaphore.make(1);
    const flush = Effect.gen(function* () {
      for (const [runId, run] of runs) {
        if (!run.dirty) {
          continue;
        }
        run.dirty = false;
        run.revision += 1;
        yield* publishWorkflowProgress({
          kind: "contribution",
          runId,
          partitionId,
          revision: run.revision,
          changes: [...run.changes].map(([definitionId, delta]) => ({
            definitionId,
            delta,
          })),
        });
      }
    }).pipe(writer.withPermit, Effect.uninterruptible);
    yield* Effect.addFinalizer(() => flush);
    yield* Queue.take(wake).pipe(
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.andThen(flush),
      Effect.forever,
      Effect.forkScoped
    );
    const itemProgress = Layer.succeed(MigrationItemProgress, {
      emit: (change) =>
        Effect.gen(function* () {
          let run = runs.get(change.runId);
          if (run === undefined) {
            run = { changes: new Map(), revision: 0, dirty: false };
            runs.set(change.runId, run);
          }
          const delta = {
            ...(run.changes.get(change.definitionId) ?? {
              migrated: 0,
              failed: 0,
              skipped: 0,
              needsUpdate: 0,
            }),
          };
          if (change.before !== null) {
            delta[
              change.before === "needs-update" ? "needsUpdate" : change.before
            ] -= 1;
          }
          if (change.after !== null) {
            delta[
              change.after === "needs-update" ? "needsUpdate" : change.after
            ] += 1;
          }
          run.changes.set(change.definitionId, delta);
          run.dirty = true;
          yield* Queue.offer(wake, undefined);
        }),
    });
    const emit = (event: MigrationProgressEvent | RollbackProgressEvent) =>
      Effect.gen(function* () {
        if (
          event.kind === "source-item-completed" ||
          event.kind === "source-item-total-counted"
        ) {
          return;
        }
        yield* flush;
        if (event.kind === "source-cursor-window-completed") {
          return;
        }
        yield* publishWorkflowProgress({
          definitionIds:
            "definitionIds" in event
              ? event.definitionIds
              : [event.definitionId],
          kind: "state-changed",
          runId: event.runId,
        }).pipe(writer.withPermit);
      });
    return Layer.mergeAll(
      itemProgress,
      Layer.succeed(MigrationProgress, { emit }),
      Layer.succeed(RollbackProgress, { emit })
    );
  })
);
