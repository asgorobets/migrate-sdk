import { Stream } from "effect";
import type { MigrationRunId } from "../../domain/ids.ts";
import {
  type MigrationExecutionUpdate,
  makeMigrationItemProgress,
} from "../../domain/item-progress.ts";
import type { MigrationDefinitionStatus } from "../../domain/status.ts";
import type {
  MigrateDashboardResume,
  MigrateDashboardSnapshot,
  MigrateObservationEvent,
} from "../../protocol/index.ts";

const makeExecutionProjection = () => {
  const progress = makeMigrationItemProgress();
  const pending = new Map<
    MigrationRunId,
    readonly MigrationDefinitionStatus[]
  >();
  const warned = new Set<MigrationRunId>();
  return {
    forget: (runId: MigrationRunId) => {
      progress.forget(runId);
      pending.delete(runId);
      warned.delete(runId);
    },
    apply: (update: MigrationExecutionUpdate) => {
      if (update.kind === "progress") {
        pending.set(update.runId, progress.apply(update.progress));
      }
      const missingBaseline =
        !progress.hasBaseline(update.runId) &&
        pending.has(update.runId) &&
        update.replaying !== true;
      const warning =
        missingBaseline && !warned.has(update.runId)
          ? `Live item totals for run ${update.runId} are unavailable; totals will reconcile when execution finishes.`
          : undefined;
      if (warning !== undefined) {
        warned.add(update.runId);
      }
      return {
        definitions:
          update.replaying === true ? [] : (pending.get(update.runId) ?? []),
        warning,
      };
    },
  };
};

export const projectRunProgress = <E, R>(
  stream: Stream.Stream<MigrateObservationEvent, E, R>
) =>
  Stream.suspend(() => {
    const projection = makeExecutionProjection();
    return stream.pipe(
      Stream.flatMap((event) => {
        if (event.kind !== "execution-progress") {
          return Stream.succeed(event);
        }
        const { definitions, warning } = projection.apply(event.update);
        if (warning !== undefined) {
          return Stream.succeed({ kind: "warning" as const, message: warning });
        }
        return definitions.length === 0
          ? Stream.empty
          : Stream.succeed({ kind: "progress" as const, definitions });
      })
    );
  });

export const makeDashboardProjection = () => {
  const projection = makeExecutionProjection();
  let snapshot: MigrateDashboardSnapshot | undefined;
  let resume: MigrateDashboardResume | undefined;
  return {
    resume: () => resume,
    apply: (next: MigrateDashboardSnapshot): MigrateDashboardSnapshot => {
      const previousStatuses = new Map(
        snapshot?.dashboard.rows.map((row) => [row.entry.id, row.status])
      );
      const statuses = new Map(
        next.dashboard.rows
          .filter((row) => row.status !== undefined)
          .map((row) => [row.entry.id, row.status])
      );
      let observationWarning = next.observationWarning;
      if (next.progress !== undefined) {
        const { definitions, warning } = projection.apply(next.progress);
        observationWarning = warning ?? observationWarning;
        for (const status of definitions) {
          const previous =
            statuses.get(status.definitionId) ??
            previousStatuses.get(status.definitionId);
          statuses.set(
            status.definitionId,
            previous === undefined
              ? status
              : { ...previous, durable: status.durable }
          );
        }
      }
      for (const metadata of next.metadata ?? []) {
        const previous =
          statuses.get(metadata.definitionId) ??
          previousStatuses.get(metadata.definitionId);
        if (previous !== undefined) {
          statuses.set(metadata.definitionId, { ...previous, ...metadata });
        }
      }
      const positions = new Map(resume?.map((run) => [run.runId, run]));
      const update = next.progress;
      resume = next.dashboard.activeRuns.map((run) => {
        const cursor =
          update?.runId === run.runId && update.cursor !== undefined
            ? update.cursor
            : positions.get(run.runId)?.cursor;
        return {
          runId: run.runId,
          observationDefinitionId: run.observationDefinitionId,
          ...(cursor === undefined ? {} : { cursor }),
        };
      });
      for (const runId of positions.keys()) {
        if (!resume.some((run) => run.runId === runId)) {
          projection.forget(runId);
        }
      }
      snapshot = {
        resumeToken: next.resumeToken,
        ...(observationWarning === undefined ? {} : { observationWarning }),
        dashboard: {
          ...next.dashboard,
          rows: next.dashboard.rows.map(({ entry }) => {
            const status =
              statuses.get(entry.id) ??
              (next.partial ? previousStatuses.get(entry.id) : undefined);
            return { entry, ...(status === undefined ? {} : { status }) };
          }),
        },
      };
      return snapshot;
    },
  };
};

export const projectDashboardProgress = <E, R>(
  stream: Stream.Stream<MigrateDashboardSnapshot, E, R>
) =>
  Stream.suspend(() => {
    const projection = makeDashboardProjection();
    return stream.pipe(Stream.map(projection.apply));
  });
