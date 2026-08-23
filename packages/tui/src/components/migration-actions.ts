import type {
  MigrationTuiAction,
  MigrationTuiRow,
  MigrationTuiTarget,
} from "../runtime.ts";

export type MigrationTuiActionView =
  | "break-lock"
  | "messages"
  | "scan"
  | "selective-run";

type MigrationTuiPrimarySlot = "lock" | "retry" | "rollback" | "run";

interface MigrationTuiPrimaryAction {
  readonly compactLabel: string;
  readonly intent: "neutral" | "primary" | "warning";
  readonly label: string;
  readonly slot: MigrationTuiPrimarySlot;
}

export interface MigrationTuiAvailableAction {
  readonly action?: MigrationTuiAction;
  readonly description: string;
  readonly id: MigrationTuiAction | MigrationTuiActionView;
  readonly key: string;
  readonly label: string;
  readonly primary?: MigrationTuiPrimaryAction;
  readonly shortcutLabel?: string;
  readonly view?: MigrationTuiActionView;
}

export const migrationTuiAvailableActions = (
  target: MigrationTuiTarget,
  rows: readonly MigrationTuiRow[]
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
      label: "Rescan source",
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
      description: `Scan source status for this ${noun} and its required dependencies`,
      id: "scan",
      key: "s",
      label: "Scan source status",
      shortcutLabel: "s scan",
      view: "scan",
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
