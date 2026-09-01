import type { MigrationRunId } from "migrate-sdk";
import type {
  MigrateAction,
  MigrateActiveRun,
  MigrateDashboardRow,
  MigratePrepareOptions,
  MigrateTarget,
} from "migrate-sdk/protocol";

export type MigrationTuiActionView =
  | "view-run"
  | "break-lock"
  | "execution-settings"
  | "messages"
  | "scan"
  | "selective-rollback"
  | "selective-run"
  | "stop-run";

type MigrationTuiPrimarySlot =
  | "attach"
  | "lock"
  | "retry"
  | "rollback"
  | "run"
  | "stop";

interface MigrationTuiPrimaryAction {
  readonly compactLabel: string;
  readonly intent: "neutral" | "primary" | "warning";
  readonly label: string;
  readonly slot: MigrationTuiPrimarySlot;
}

interface MigrationTuiAvailableActionBase {
  readonly description: string;
  readonly key: string;
  readonly label: string;
  readonly primary?: MigrationTuiPrimaryAction;
  readonly shortcutLabel?: string;
}

type MigrationTuiStandardOperationAction = {
  readonly [Action in MigrateAction]: MigrationTuiAvailableActionBase & {
    readonly action: Action;
    readonly id: Action;
    readonly options?: MigratePrepareOptions;
    readonly runId?: never;
    readonly view?: never;
  };
}[MigrateAction];

type MigrationTuiRollbackOrphansAction = MigrationTuiAvailableActionBase & {
  readonly action: "run";
  readonly id: "rollback-orphans";
  readonly options: MigratePrepareOptions & { readonly rollbackOrphans: true };
  readonly runId?: never;
  readonly view?: never;
};

type MigrationTuiOperationAction =
  | MigrationTuiRollbackOrphansAction
  | MigrationTuiStandardOperationAction;

type MigrationTuiNonRunView = Exclude<
  MigrationTuiActionView,
  "view-run" | "stop-run"
>;

type MigrationTuiViewAction = {
  readonly [View in MigrationTuiNonRunView]: MigrationTuiAvailableActionBase & {
    readonly action?: never;
    readonly id: View;
    readonly runId?: never;
    readonly view: View;
  };
}[MigrationTuiNonRunView];

type MigrationTuiRunViewAction = MigrationTuiAvailableActionBase & {
  readonly action?: never;
  readonly id: "view-run" | "stop-run";
  readonly runId: MigrationRunId;
  readonly view: "view-run" | "stop-run";
};

export type MigrationTuiAvailableAction =
  | MigrationTuiRunViewAction
  | MigrationTuiOperationAction
  | MigrationTuiViewAction;

export const migrationTuiAvailableActions = (
  target: MigrateTarget,
  rows: readonly MigrateDashboardRow[],
  activeRuns: readonly MigrateActiveRun[] = []
): readonly MigrationTuiAvailableAction[] => {
  const isGroup = target.kind === "group";
  const noun = isGroup ? "group" : "migration";
  const options: MigrationTuiAvailableAction[] = [
    {
      action: "run",
      description: isGroup
        ? "Run every migration in this group"
        : "Run this migration",
      id: "run",
      key: "r",
      label: isGroup ? "Run group" : "Run",
      primary: {
        compactLabel: "r Run",
        intent: "primary",
        label: isGroup ? "r Run group" : "r Run",
        slot: "run",
      },
      shortcutLabel: "r run",
    },
  ];
  const matchingActiveRuns = activeRuns.filter((run) =>
    rows.some((row) => row.status?.lock?.ownerRunId === run.runId)
  );
  const activeRun =
    matchingActiveRuns.length === 1 ? matchingActiveRuns[0] : undefined;

  if (activeRun !== undefined) {
    options.unshift({
      description: `View live progress for run ${activeRun.runId}`,
      id: "view-run",
      key: "v",
      label: "View run",
      primary: {
        compactLabel: "v View run",
        intent: "primary",
        label: "v View run",
        slot: "attach",
      },
      runId: activeRun.runId,
      shortcutLabel: "v view run",
      view: "view-run",
    });

    if (activeRun.stopSupported === true) {
      options.push({
        description: `Request a safe stop for run ${activeRun.runId}`,
        id: "stop-run",
        key: "x",
        label: "Stop run",
        primary: {
          compactLabel: "x Stop",
          intent: "warning",
          label: "x Stop run",
          slot: "stop",
        },
        runId: activeRun.runId,
        shortcutLabel: "x stop run",
        view: "stop-run",
      });
    }
  }

  if (!isGroup) {
    options.push({
      description:
        "Run specific source identities, including identities from history",
      id: "selective-run",
      key: "e",
      label: "Run selected entries",
      view: "selective-run",
    });
  }

  if (rows.some((row) => (row.status?.durable.failed ?? 0) > 0)) {
    options.push({
      action: "retry-failed",
      description: `Retry only failed items in this ${noun}`,
      id: "retry-failed",
      key: "f",
      label: "Retry failed",
      primary: {
        compactLabel: "f Retry",
        intent: "warning",
        label: "f Retry failed",
        slot: "retry",
      },
      shortcutLabel: "f retry failed",
    });
  }

  if (rows.some((row) => (row.status?.durable.skipped ?? 0) > 0)) {
    options.push({
      action: "retry-skipped",
      description: `Retry only skipped items in this ${noun}`,
      id: "retry-skipped",
      key: "t",
      label: "Retry skipped",
      primary: {
        compactLabel: "t Retry",
        intent: "warning",
        label: "t Retry skipped",
        slot: "retry",
      },
      shortcutLabel: "t retry skipped",
    });
  }

  options.push(
    {
      action: "rescan",
      description: `Scan this ${noun} from the beginning and skip unchanged items`,
      id: "rescan",
      key: "",
      label: "Source Rescan",
    },
    {
      action: "update",
      description: `Scan this ${noun} from the beginning and reprocess migrated items`,
      id: "update",
      key: "",
      label: "Update",
    }
  );

  if (rows.length > 0 && rows.every((row) => row.entry.hasRollback)) {
    options.push({
      action: "rollback",
      description: isGroup
        ? "Rollback every migration in this group"
        : "Rollback this migration and affected dependents in safe order",
      id: "rollback",
      key: "b",
      label: isGroup ? "Rollback group" : "Rollback",
      primary: {
        compactLabel: "b Rollback",
        intent: "neutral",
        label: isGroup ? "b Rollback group" : "b Rollback",
        slot: "rollback",
      },
      shortcutLabel: "b rollback",
    });

    if (!isGroup) {
      options.push({
        description:
          "Rollback specific source identities, including identities from history",
        id: "selective-rollback",
        key: "",
        label: "Rollback selected entries",
        view: "selective-rollback",
      });
    }

    options.push({
      action: "run",
      description: `Rollback destination items no longer present in the ${noun} source inventory`,
      id: "rollback-orphans",
      key: "",
      label: "Rollback orphans",
      options: { rollbackOrphans: true },
    });
  }

  if (!isGroup && rows[0]?.status?.lock != null) {
    options.push({
      description: `Clear the lock owned by run ${rows[0].status.lock.ownerRunId}`,
      id: "break-lock",
      key: "u",
      label: "Break lock",
      primary: {
        compactLabel: "u Break lock",
        intent: "warning",
        label: "u Break lock",
        slot: "lock",
      },
      shortcutLabel: "u break lock",
      view: "break-lock",
    });
  }

  options.push(
    {
      description: `View ${noun} errors, warnings, and messages`,
      id: "messages",
      key: "m",
      label: "Messages",
      shortcutLabel: "m messages",
      view: "messages",
    },
    {
      description: `Run a Source Inventory Scan for this ${noun} and its required dependencies`,
      id: "scan",
      key: "s",
      label: "Source Inventory Scan",
      shortcutLabel: "s inventory scan",
      view: "scan",
    },
    {
      description:
        "Set Process Pipeline, Rollback Pipeline, and Source Inventory Scan concurrency",
      id: "execution-settings",
      key: "c",
      label: "Concurrency settings",
      view: "execution-settings",
    }
  );

  return options;
};

const primarySlotOrder: readonly MigrationTuiPrimarySlot[] = [
  "run",
  "retry",
  "rollback",
];

export const migrationTuiPrimaryActions = (
  actions: readonly MigrationTuiAvailableAction[]
): readonly MigrationTuiAvailableAction[] => {
  const attach = actions.find((action) => action.primary?.slot === "attach");

  if (attach !== undefined) {
    const stop = actions.find((action) => action.primary?.slot === "stop");
    return stop === undefined ? [attach] : [attach, stop];
  }

  const breakLock = actions.find((action) => action.primary?.slot === "lock");

  if (breakLock !== undefined) {
    return [breakLock];
  }

  return primarySlotOrder.flatMap((slot) => {
    const action = actions.find(
      (candidate) => candidate.primary?.slot === slot
    );
    return action === undefined ? [] : [action];
  });
};

export const migrationTuiActionForKey = (
  actions: readonly MigrationTuiAvailableAction[],
  key: string
): MigrationTuiAvailableAction | undefined =>
  actions.find((action) => action.key !== "" && action.key === key);

export const migrationTuiUtilityActions = (
  actions: readonly MigrationTuiAvailableAction[]
): readonly MigrationTuiAvailableAction[] =>
  actions.filter((action) => action.id === "messages" || action.id === "scan");
