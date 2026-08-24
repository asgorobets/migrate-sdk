import { Effect, Layer, Schema } from "effect";
import {
  MigrationProgress,
  type MigrationProgressEvent,
} from "migrate-sdk/core";
import { getWritable } from "workflow";

export const workflowSdkMigrationProgressStreamNamespace =
  "migrate-sdk-progress";

const WorkflowSdkMigrationProgressCount = Schema.Finite.check(
  Schema.isInt()
).check(Schema.isGreaterThanOrEqualTo(0));

export const WorkflowSdkMigrationProgressCheckpoint = Schema.Struct({
  counts: Schema.Struct({
    failed: WorkflowSdkMigrationProgressCount,
    migrated: WorkflowSdkMigrationProgressCount,
    needsUpdate: WorkflowSdkMigrationProgressCount,
    orphaned: Schema.optional(WorkflowSdkMigrationProgressCount),
    rollbackFailed: Schema.optional(WorkflowSdkMigrationProgressCount),
    rolledBack: Schema.optional(WorkflowSdkMigrationProgressCount),
    skipped: WorkflowSdkMigrationProgressCount,
    unchanged: WorkflowSdkMigrationProgressCount,
  }),
  definitionId: Schema.NonEmptyString,
  kind: Schema.Literal("source-cursor-window-completed"),
  runId: Schema.NonEmptyString,
});

export type WorkflowSdkMigrationProgressCheckpoint =
  typeof WorkflowSdkMigrationProgressCheckpoint.Type;

const checkpointFromEvent = (
  event: MigrationProgressEvent
): WorkflowSdkMigrationProgressCheckpoint | undefined =>
  event.kind === "source-cursor-window-completed"
    ? {
        counts: event.counts,
        definitionId: event.definitionId,
        kind: event.kind,
        runId: event.runId,
      }
    : undefined;

const publishCheckpoint = (
  checkpoint: WorkflowSdkMigrationProgressCheckpoint
): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      const writer = getWritable<WorkflowSdkMigrationProgressCheckpoint>({
        namespace: workflowSdkMigrationProgressStreamNamespace,
      }).getWriter();

      try {
        await writer.write(checkpoint);
      } finally {
        writer.releaseLock();
      }
    } catch {
      // Progress delivery is supplemental and must not fail migration work.
    }
  });

export const workflowSdkMigrationProgressLayer = Layer.succeed(
  MigrationProgress,
  {
    emit: (event) => {
      const checkpoint = checkpointFromEvent(event);

      return checkpoint === undefined
        ? Effect.void
        : publishCheckpoint(checkpoint);
    },
  }
);
