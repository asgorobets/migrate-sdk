import { Schema } from "effect";
import { MigrationDefinitionId, MigrationRunId } from "./ids.ts";
import { MigrationDefinitionStatus } from "./status.ts";

const Integer = Schema.Finite.check(Schema.isInt());
const Position = Integer.check(Schema.isGreaterThanOrEqualTo(0));

/** Net changes to stored states, not the outcomes counted by a run. */
export const MigrationItemStateDelta = Schema.Struct({
  migrated: Integer,
  failed: Integer,
  skipped: Integer,
  needsUpdate: Integer,
});
export type MigrationItemStateDelta = typeof MigrationItemStateDelta.Type;

export const MigrationItemProgress = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("baseline"),
    runId: MigrationRunId,
    definitions: Schema.Array(MigrationDefinitionStatus),
  }),
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    runId: MigrationRunId,
    partitionId: Schema.NonEmptyString,
    revision: Position,
    changes: Schema.Array(
      Schema.Struct({
        definitionId: MigrationDefinitionId,
        delta: MigrationItemStateDelta,
      })
    ),
  }),
]);
export type MigrationItemProgress = typeof MigrationItemProgress.Type;

export const MigrationExecutionUpdate = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("progress"),
    runId: MigrationRunId,
    progress: MigrationItemProgress,
    cursor: Schema.optionalKey(Schema.String),
    replaying: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("state-changed"),
    runId: MigrationRunId,
    definitionIds: Schema.Array(MigrationDefinitionId),
    cursor: Schema.optionalKey(Schema.String),
    replaying: Schema.optionalKey(Schema.Boolean),
  }),
]);
export type MigrationExecutionUpdate = typeof MigrationExecutionUpdate.Type;

/** Display state only. Never use this projection to authorize execution. */
export const makeMigrationItemProgress = () => {
  const baselines = new Map<
    MigrationRunId,
    readonly MigrationDefinitionStatus[]
  >();
  const snapshots = new Map<
    MigrationRunId,
    Map<string, Extract<MigrationItemProgress, { kind: "snapshot" }>>
  >();
  const totals = new Map<
    MigrationRunId,
    Map<MigrationDefinitionId, MigrationItemStateDelta>
  >();
  const changeTotal = (
    runId: MigrationRunId,
    changes: Extract<MigrationItemProgress, { kind: "snapshot" }>["changes"],
    direction: number
  ) => {
    let summary = totals.get(runId);
    if (summary === undefined) {
      summary = new Map();
      totals.set(runId, summary);
    }
    for (const { definitionId, delta } of changes) {
      const previous = summary.get(definitionId) ?? {
        migrated: 0,
        failed: 0,
        skipped: 0,
        needsUpdate: 0,
      };
      summary.set(definitionId, {
        migrated: previous.migrated + direction * delta.migrated,
        failed: previous.failed + direction * delta.failed,
        skipped: previous.skipped + direction * delta.skipped,
        needsUpdate: previous.needsUpdate + direction * delta.needsUpdate,
      });
    }
  };
  return {
    hasBaseline: (runId: MigrationRunId) => baselines.has(runId),
    forget: (runId: MigrationRunId) => {
      baselines.delete(runId);
      snapshots.delete(runId);
      totals.delete(runId);
    },
    apply: (
      event: MigrationItemProgress
    ): readonly MigrationDefinitionStatus[] => {
      if (event.kind === "baseline") {
        // A retried begin step must not move the baseline past committed work.
        if (!baselines.has(event.runId)) {
          baselines.set(event.runId, event.definitions);
        }
      } else {
        let partitions = snapshots.get(event.runId);
        if (partitions === undefined) {
          partitions = new Map();
          snapshots.set(event.runId, partitions);
        }
        const previous = partitions.get(event.partitionId);
        if (previous === undefined || previous.revision < event.revision) {
          if (previous !== undefined) {
            changeTotal(event.runId, previous.changes, -1);
          }
          changeTotal(event.runId, event.changes, 1);
          partitions.set(event.partitionId, event);
        }
      }
      return (baselines.get(event.runId) ?? []).map((status) => {
        const delta = totals.get(event.runId)?.get(status.definitionId);
        const durable = {
          migrated: status.durable.migrated + (delta?.migrated ?? 0),
          failed: status.durable.failed + (delta?.failed ?? 0),
          skipped: status.durable.skipped + (delta?.skipped ?? 0),
          needsUpdate: status.durable.needsUpdate + (delta?.needsUpdate ?? 0),
        };
        // Missing publications are reconciled from the store when execution settles.
        return {
          ...status,
          durable: {
            migrated: Math.max(0, durable.migrated),
            failed: Math.max(0, durable.failed),
            skipped: Math.max(0, durable.skipped),
            needsUpdate: Math.max(0, durable.needsUpdate),
          },
        };
      });
    },
  };
};
