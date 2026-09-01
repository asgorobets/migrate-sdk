import { Duration, Effect, Option, Schedule, Stream } from "effect";
import type { MigrationMessage } from "migrate-sdk";
import type {
  MigrateDashboard,
  MigrateDashboardSnapshot,
  MigrateDefinitionSourceItemTotal,
  MigrateSourceItemTotal,
  MigrateTarget,
} from "migrate-sdk/protocol";

export interface BrowserMigrateDashboardObservationState {
  initialized: boolean;
  messagesDashboard: MigrateDashboard | undefined;
  sourceTotalsLoaded: boolean;
}

interface BrowserMigrateDashboardObservationSource {
  readonly getMessages: (
    target: MigrateTarget
  ) => Effect.Effect<readonly MigrationMessage[], unknown>;
  readonly getSourceItemTotals: (
    definitionIds: readonly [
      MigrateDashboard["rows"][number]["entry"]["id"],
      ...MigrateDashboard["rows"][number]["entry"]["id"][],
    ]
  ) => Effect.Effect<readonly MigrateDefinitionSourceItemTotal[], unknown>;
  readonly snapshots: Stream.Stream<MigrateDashboardSnapshot, unknown>;
}

interface BrowserMigrateDashboardObservationSink {
  readonly onDashboard: (
    dashboard: MigrateDashboard,
    announceChanges: boolean
  ) => void;
  readonly onMessages: (messages: readonly MigrationMessage[]) => void;
  readonly onSourceTotals: (
    totals: ReadonlyMap<
      MigrateDashboard["rows"][number]["entry"]["id"],
      MigrateSourceItemTotal
    >
  ) => void;
}

type RetryAncillary = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, R>;

interface ObserveBrowserMigrateDashboardInput {
  readonly retryAncillary?: RetryAncillary | undefined;
  readonly sink: BrowserMigrateDashboardObservationSink;
  readonly source: BrowserMigrateDashboardObservationSource;
  readonly state: BrowserMigrateDashboardObservationState;
}

const ancillaryRetrySchedule = Schedule.recurs(2).pipe(
  Schedule.addDelay(({ attempt }) =>
    Effect.succeed(Duration.millis(250 * 2 ** (attempt - 1)))
  )
);

const retryAncillaryDefault: RetryAncillary = (effect) =>
  effect.pipe(Effect.retry(ancillaryRetrySchedule));

const messageTarget = (
  dashboard: MigrateDashboard
): MigrateTarget | undefined => {
  const catalog =
    dashboard.groups.find((group) => group.id === "catalog") ??
    dashboard.groups[0];
  if (catalog !== undefined) {
    return { groupId: catalog.id, kind: "group" };
  }

  const firstRow = dashboard.rows[0];
  return firstRow === undefined
    ? undefined
    : { definitionId: firstRow.entry.id, kind: "migration" };
};

const sortMessages = (
  messages: readonly MigrationMessage[]
): readonly MigrationMessage[] =>
  [...messages].sort((left, right) => {
    const time = left.updatedAt.getTime() - right.updatedAt.getTime();
    if (time !== 0) {
      return time;
    }
    return (left.sequence ?? -1) - (right.sequence ?? -1);
  });

export const migrationMessageStateChanged = (
  previous: MigrateDashboard | undefined,
  next: MigrateDashboard
): boolean => {
  if (previous === undefined) {
    return true;
  }

  const nextRunIds = new Set(next.activeRuns.map((run) => run.runId));
  if (previous.activeRuns.some((run) => !nextRunIds.has(run.runId))) {
    return true;
  }

  const previousRows = new Map(previous.rows.map((row) => [row.entry.id, row]));
  return next.rows.some((row) => {
    const previousStatus = previousRows.get(row.entry.id)?.status;
    const nextStatus = row.status;
    const previousDurable = previousStatus?.durable;
    const nextDurable = nextStatus?.durable;
    return (
      nextStatus?.lastRun?.runId !== previousStatus?.lastRun?.runId ||
      (nextDurable !== undefined &&
        (nextDurable.failed !== (previousDurable?.failed ?? 0) ||
          nextDurable.needsUpdate !== (previousDurable?.needsUpdate ?? 0) ||
          nextDurable.skipped !== (previousDurable?.skipped ?? 0)))
    );
  });
};

export const observeBrowserMigrateDashboard = ({
  retryAncillary = retryAncillaryDefault,
  sink,
  source,
  state,
}: ObserveBrowserMigrateDashboardInput): Effect.Effect<void, unknown> =>
  source.snapshots.pipe(
    Stream.runForEach((snapshot) =>
      Effect.gen(function* () {
        const next = snapshot.dashboard;
        const shouldLoadMessages = migrationMessageStateChanged(
          state.messagesDashboard,
          next
        );
        const definitionIds = next.rows.map((row) => row.entry.id);
        const shouldLoadSourceTotals = !state.sourceTotalsLoaded;

        yield* Effect.sync(() => {
          sink.onDashboard(next, state.initialized);
          state.initialized = true;
        });

        const target = shouldLoadMessages ? messageTarget(next) : undefined;
        const results = yield* Effect.all(
          {
            messages:
              shouldLoadMessages && target !== undefined
                ? retryAncillary(source.getMessages(target)).pipe(Effect.option)
                : Effect.succeed(
                    shouldLoadMessages
                      ? Option.some<readonly MigrationMessage[]>([])
                      : undefined
                  ),
            totals:
              shouldLoadSourceTotals && definitionIds.length > 0
                ? retryAncillary(
                    source.getSourceItemTotals([
                      definitionIds[0] as (typeof definitionIds)[number],
                      ...definitionIds.slice(1),
                    ])
                  ).pipe(Effect.option)
                : Effect.succeed(
                    shouldLoadSourceTotals
                      ? Option.some<
                          readonly MigrateDefinitionSourceItemTotal[]
                        >([])
                      : undefined
                  ),
          },
          { concurrency: "unbounded" }
        );

        yield* Effect.sync(() => {
          if (results.totals !== undefined && Option.isSome(results.totals)) {
            sink.onSourceTotals(
              new Map(
                results.totals.value.map(({ definitionId, total }) => [
                  definitionId,
                  total,
                ])
              )
            );
            state.sourceTotalsLoaded = true;
          }
          if (
            results.messages !== undefined &&
            Option.isSome(results.messages)
          ) {
            sink.onMessages(sortMessages(results.messages.value));
            state.messagesDashboard = next;
          }
        });
      })
    )
  );
