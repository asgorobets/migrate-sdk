import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  MigrateActiveRun,
  MigrateDashboardRow,
} from "migrate-sdk/protocol";

export const sessionActivityLimit = 5000;

export type SessionActivityKind = "error" | "notice" | "status" | "warning";

export interface SessionActivityEntry {
  readonly kind: SessionActivityKind;
  readonly message: string;
  readonly occurredAt: Date;
  readonly sequence: number;
}

export interface SessionActivityState {
  readonly entries: readonly SessionActivityEntry[];
  readonly nextSequence: number;
  readonly omitted: number;
}

export interface SessionActivityInput {
  readonly kind: SessionActivityKind;
  readonly message: string;
  readonly occurredAt?: Date | undefined;
}

export interface SessionRunActivitySnapshot {
  readonly activeRuns: readonly MigrateActiveRun[];
  readonly rows: readonly MigrateDashboardRow[];
}

type DashboardRunState = NonNullable<
  NonNullable<MigrateDashboardRow["status"]>["lastRun"]
>;

const runDefinitionsLabel = (run: MigrateActiveRun): string =>
  run.definitionIds.join(", ");

const activeRunActivity = (run: MigrateActiveRun): SessionActivityInput => {
  const definitions = runDefinitionsLabel(run);

  switch (run.status) {
    case "queued":
      return {
        kind: "status",
        message: `Run ${run.runId} queued · ${definitions}`,
      };
    case "running":
      return {
        kind: "status",
        message: `Run ${run.runId} running · ${definitions}`,
      };
    case "cancelling":
      return {
        kind: "warning",
        message: `Run ${run.runId} stopping · ${definitions}`,
      };
    default: {
      const unhandled: never = run.status;
      return unhandled;
    }
  }
};

const terminalRunActivity = (
  run: DashboardRunState
): SessionActivityInput | undefined => {
  const definitions =
    run.definitionIds.length === 0
      ? run.definitionId
      : run.definitionIds.join(", ");

  switch (run.runStatus) {
    case "succeeded":
      return {
        kind: "notice",
        message: `Run ${run.runId} succeeded · ${definitions}`,
      };
    case "failed":
      return {
        kind: "error",
        message: `Run ${run.runId} failed · ${definitions}`,
      };
    case "start-failed":
      return {
        kind: "error",
        message: `Run ${run.runId} failed to start · ${definitions}`,
      };
    case "cancelled":
      return {
        kind: "warning",
        message: `Run ${run.runId} cancelled · ${definitions}`,
      };
    default:
      return;
  }
};

const dashboardRunStates = (
  rows: readonly MigrateDashboardRow[]
): ReadonlyMap<DashboardRunState["runId"], DashboardRunState> =>
  new Map(
    rows.flatMap((row) => {
      const run = row.status?.lastRun;
      return run === null || run === undefined ? [] : [[run.runId, run]];
    })
  );

const completedActiveRunActivity = (
  run: MigrateActiveRun,
  runStates: ReadonlyMap<DashboardRunState["runId"], DashboardRunState>
): SessionActivityInput =>
  terminalRunActivity(
    runStates.get(run.runId) ?? {
      definitionId: run.observationDefinitionId,
      definitionIds: run.definitionIds,
      runId: run.runId,
      runStatus: run.status,
      startedAt: run.startedAt,
      status: run.status,
    }
  ) ?? {
    kind: "status",
    message: `Run ${run.runId} is no longer active · ${runDefinitionsLabel(run)}`,
  };

export const observedRunActivity = (
  previous: SessionRunActivitySnapshot | undefined,
  current: SessionRunActivitySnapshot
): readonly SessionActivityInput[] => {
  const previousById = new Map(
    previous?.activeRuns.map((run) => [run.runId, run])
  );
  const currentById = new Map(
    current.activeRuns.map((run) => [run.runId, run])
  );
  const previousRunStates = dashboardRunStates(previous?.rows ?? []);
  const currentRunStates = dashboardRunStates(current.rows);
  const recordedRunIds = new Set<DashboardRunState["runId"]>();
  const activity: SessionActivityInput[] = [];

  for (const run of previous?.activeRuns ?? []) {
    if (!currentById.has(run.runId)) {
      activity.push(completedActiveRunActivity(run, currentRunStates));
      recordedRunIds.add(run.runId);
    }
  }

  for (const run of current.activeRuns) {
    const previousRun = previousById.get(run.runId);

    if (previousRun === undefined || previousRun.status !== run.status) {
      activity.push(activeRunActivity(run));
      recordedRunIds.add(run.runId);
    }
  }

  if (previous !== undefined) {
    for (const [runId, run] of currentRunStates) {
      const previousRun = previousRunStates.get(runId);
      const terminalActivity = terminalRunActivity(run);

      if (
        terminalActivity !== undefined &&
        !recordedRunIds.has(runId) &&
        !currentById.has(runId) &&
        (previousRun === undefined || previousRun.runStatus !== run.runStatus)
      ) {
        activity.push(terminalActivity);
      }
    }
  }

  return activity;
};

export const emptySessionActivity = (): SessionActivityState => ({
  entries: [],
  nextSequence: 1,
  omitted: 0,
});

export const appendSessionActivity = (
  state: SessionActivityState,
  input: SessionActivityInput,
  limit = sessionActivityLimit
): SessionActivityState => {
  const message = input.message.trim();

  if (message === "") {
    return state;
  }

  const nextEntries = [
    ...state.entries,
    {
      kind: input.kind,
      message,
      occurredAt: input.occurredAt ?? new Date(),
      sequence: state.nextSequence,
    },
  ];
  const overflow = Math.max(0, nextEntries.length - Math.max(1, limit));

  return {
    entries: overflow === 0 ? nextEntries : nextEntries.slice(overflow),
    nextSequence: state.nextSequence + 1,
    omitted: state.omitted + overflow,
  };
};

export const sessionActivityJsonLines = (
  entries: readonly SessionActivityEntry[]
): string =>
  entries
    .map((entry) =>
      JSON.stringify({
        kind: entry.kind,
        message: entry.message,
        occurredAt: entry.occurredAt.toISOString(),
        sequence: entry.sequence,
      })
    )
    .join("\n");

export const defaultSessionActivityExportPath = (now = new Date()): string => {
  const timestamp = now.toISOString();
  const date = timestamp.slice(0, 10).replaceAll("-", "");
  const time = timestamp.slice(11, 19).replaceAll(":", "");

  return `migrate-activity-${date}-${time}.jsonl`;
};

export const exportSessionActivity = async (
  entries: readonly SessionActivityEntry[],
  outputPath: string,
  cwd = process.cwd()
): Promise<string> => {
  const trimmedPath = outputPath.trim();

  if (trimmedPath === "") {
    throw new Error("Choose a file for the activity export");
  }

  const resolvedPath = resolve(cwd, trimmedPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  const contents = sessionActivityJsonLines(entries);
  try {
    await writeFile(resolvedPath, contents === "" ? "" : `${contents}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "EEXIST"
    ) {
      throw new Error("That file already exists. Choose a different file.", {
        cause,
      });
    }

    throw cause;
  }

  return resolvedPath;
};
