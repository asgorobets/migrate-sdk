import type { ActiveMigrationRun, MigrationRunId } from "migrate-sdk";
import type {
  MigrationTuiAction,
  MigrationTuiRow,
  MigrationTuiTarget,
} from "../runtime.ts";

export type MigrationTuiActionView =
  | "attach-run"
  | "break-lock"
  | "execution-settings"
  | "messages"
  | "scan"
  | "selective-run";

type MigrationTuiPrimarySlot = "attach" | "lock" | "retry" | "rollback" | "run";

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

type MigrationTuiOperationAction = {
  readonly [Action in MigrationTuiAction]: MigrationTuiAvailableActionBase & {
    readonly action: Action;
    readonly id: Action;
    readonly runId?: never;
    readonly view?: never;
  };
}[MigrationTuiAction];

type MigrationTuiNonAttachView = Exclude<MigrationTuiActionView, "attach-run">;

type MigrationTuiViewAction = {
  readonly [View in MigrationTuiNonAttachView]: MigrationTuiAvailableActionBase & {
    readonly action?: never;
    readonly id: View;
    readonly runId?: never;
    readonly view: View;
  };
}[MigrationTuiNonAttachView];

type MigrationTuiAttachAction = MigrationTuiAvailableActionBase & {
  readonly action?: never;
  readonly id: "attach-run";
  readonly runId: MigrationRunId;
  readonly view: "attach-run";
};

export type MigrationTuiAvailableAction =
  | MigrationTuiAttachAction
  | MigrationTuiOperationAction
  | MigrationTuiViewAction;

export const migrationTuiAvailableActions = (
  target: MigrationTuiTarget,
  rows: readonly MigrationTuiRow[],
  activeRuns: readonly ActiveMigrationRun[] = []
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
  const matchingActiveRuns = activeRuns.filter(
    (run) =>
      run.execution !== undefined &&
      rows.some((row) => row.status?.lock?.ownerRunId === run.runId)
  );
  const activeRun =
    matchingActiveRuns.length === 1 ? matchingActiveRuns[0] : undefined;

  if (activeRun !== undefined) {
    options.unshift({
      description: `Follow live progress for run ${activeRun.runId}`,
      id: "attach-run",
      key: "a",
      label: "Attach to run",
      primary: {
        compactLabel: "a Attach",
        intent: "primary",
        label: "a Attach to run",
        slot: "attach",
      },
      runId: activeRun.runId,
      shortcutLabel: "a attach",
      view: "attach-run",
    });
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
    return [attach];
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
