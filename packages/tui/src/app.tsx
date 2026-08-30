import { type KeyEvent, RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type {
  MigrationDefinitionId,
  MigrationExecutionOptions,
  MigrationRunId,
  PipelineExecutionConcurrency,
} from "migrate-sdk";
import type {
  MigrateAction,
  MigrateDashboardRow,
  MigratePreparedOperation,
  MigratePrepareOptions,
  MigrateRunStopResult,
  MigrateSelection,
  MigrateSourceIdentityHistoryEntry,
  MigrateTarget,
} from "migrate-sdk/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BreakLockDialog } from "./components/break-lock-dialog.tsx";
import {
  ExecutionSettingsDialog,
  type MigrationTuiExecutionSettingsDrafts,
} from "./components/execution-settings-dialog.tsx";
import { MessageDetailDialog } from "./components/message-detail-dialog.tsx";
import {
  type MigrationTuiAvailableAction,
  migrationTuiActionForKey,
  migrationTuiAvailableActions,
} from "./components/migration-actions.ts";
import {
  migrationColors as colors,
  MigrationDashboard,
  type MigrationDetailTab,
  type MigrationListTab,
  migrationStatusColor,
  migrationStatusIcon,
  migrationStatusLabel,
} from "./components/migration-dashboard.tsx";
import { SelectiveRunDialog } from "./components/selective-run-dialog.tsx";
import {
  SessionActivityView,
  type SessionActivityViewMode,
} from "./components/session-activity-view.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import type { MigrationTuiExecutionResult } from "./execution.ts";
import { nextListSelection } from "./list-navigation.ts";
import type { MigrationTuiRuntime } from "./runtime.ts";
import {
  appendSessionActivity,
  defaultSessionActivityExportPath,
  emptySessionActivity,
  exportSessionActivity,
  type SessionActivityEntry,
  type SessionActivityKind,
} from "./session-activity.ts";
import type { MigrationTuiShutdownController } from "./shutdown-controller.ts";
import { useDashboardObservation } from "./use-dashboard-observation.ts";
import { useMigrationMessages } from "./use-migration-messages.ts";
import { useSourceItemTotals } from "./use-source-item-totals.ts";

type View =
  | "actions"
  | "activity"
  | "activity-detail"
  | "activity-export"
  | "break-lock"
  | "confirm"
  | "dashboard"
  | "execution-settings"
  | "message-detail"
  | "selective-rollback"
  | "selective-run";

interface MigrationTuiExecutionSettings {
  readonly process?: PipelineExecutionConcurrency;
  readonly rollback?: PipelineExecutionConcurrency;
  readonly sourceInventoryScan?: number;
}

type NoticeTone = "notice" | "status" | "warning";

interface SessionActivityKeyHandlerInput {
  readonly count: number;
  readonly index: number;
  readonly onBack: () => void;
  readonly onExpand: () => void;
  readonly onExport: () => void;
  readonly onSelectionChange: (index: number, following: boolean) => void;
}

const handleSessionActivityKey = (
  key: KeyEvent,
  input: SessionActivityKeyHandlerInput
): void => {
  if (key.name === "escape") {
    key.preventDefault();
    key.stopPropagation();
    input.onBack();
    return;
  }
  if (key.name === "e" && input.count > 0) {
    key.preventDefault();
    key.stopPropagation();
    input.onExport();
    return;
  }
  if ((key.name === "return" || key.name === "linefeed") && input.count > 0) {
    key.preventDefault();
    key.stopPropagation();
    input.onExpand();
    return;
  }

  const nextIndex = nextListSelection(key.name, input.index, input.count);

  if (nextIndex === undefined) {
    return;
  }

  key.preventDefault();
  key.stopPropagation();
  input.onSelectionChange(
    nextIndex,
    nextIndex === Math.max(0, input.count - 1)
  );
};

const handleSessionActivityExportKey = (
  key: KeyEvent,
  inputReady: boolean,
  onCancel: () => void,
  onSave: () => void
): void => {
  if (!inputReady) {
    return;
  }

  if (key.name === "escape") {
    key.preventDefault();
    key.stopPropagation();
    onCancel();
  } else if (key.ctrl && key.name === "s") {
    key.preventDefault();
    key.stopPropagation();
    onSave();
  }
};

const isSessionActivityView = (view: View): view is SessionActivityViewMode =>
  view === "activity" ||
  view === "activity-detail" ||
  view === "activity-export";

const stopResultPresentation = {
  "not-running": { activityKind: "status", noticeTone: "status" },
  requested: { activityKind: "notice", noticeTone: "notice" },
  unsupported: { activityKind: "warning", noticeTone: "warning" },
} as const satisfies Record<
  MigrateRunStopResult["kind"],
  {
    readonly activityKind: SessionActivityKind;
    readonly noticeTone: NoticeTone;
  }
>;

const noticeColor = (tone: NoticeTone): string => {
  switch (tone) {
    case "notice":
      return colors.success;
    case "status":
      return colors.info;
    case "warning":
      return colors.warning;
    default: {
      const unhandled: never = tone;
      return unhandled;
    }
  }
};

const runObservationResultPresentation = {
  cancelled: { activityKind: "warning", noticeTone: "warning" },
  completed: { activityKind: "notice", noticeTone: "notice" },
  detached: { activityKind: "status", noticeTone: "status" },
} as const satisfies Record<
  MigrationTuiExecutionResult["outcome"],
  {
    readonly activityKind: SessionActivityKind;
    readonly noticeTone: NoticeTone;
  }
>;

const pipelineConcurrencyDraft = (
  concurrency: PipelineExecutionConcurrency | undefined
): { readonly unbounded: boolean; readonly value: number | null } => ({
  unbounded: concurrency === "unbounded",
  value: typeof concurrency === "number" ? concurrency : null,
});

const migrationExecutionOptions = (
  settings: MigrationTuiExecutionSettings
): MigrationExecutionOptions | undefined => {
  if (settings.process === undefined && settings.rollback === undefined) {
    return;
  }

  return {
    ...(settings.process === undefined
      ? {}
      : { process: { concurrency: settings.process } }),
    ...(settings.rollback === undefined
      ? {}
      : { rollback: { concurrency: settings.rollback } }),
  };
};

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
};

const targetLabel = (target: MigrateTarget): string =>
  target.kind === "group" ? target.groupId : target.definitionId;

const selectionFromTarget = (target: MigrateTarget): MigrateSelection =>
  target.kind === "group"
    ? { groupId: target.groupId, kind: "group" }
    : { definitionIds: [target.definitionId], kind: "definitions" };

const selectionLabel = (selection: MigrateSelection): string => {
  switch (selection.kind) {
    case "all":
      return "all migrations";
    case "definitions":
      return selection.definitionIds.join(", ");
    case "group":
      return selection.groupId;
    default: {
      const unhandled: never = selection;
      return unhandled;
    }
  }
};

const actionCopy = {
  rescan: {
    button: "rescan",
    preparing: "Preparing to rescan",
    progress: "Rescanning",
  },
  "retry-failed": {
    button: "retry",
    preparing: "Preparing to retry failed items for",
    progress: "Retrying failed items for",
  },
  "retry-skipped": {
    button: "retry",
    preparing: "Preparing to retry skipped items for",
    progress: "Retrying skipped items for",
  },
  rollback: {
    button: "rollback",
    preparing: "Preparing to roll back",
    progress: "Rolling back",
  },
  run: {
    button: "run",
    preparing: "Preparing to run",
    progress: "Running",
  },
  update: {
    button: "update",
    preparing: "Preparing to update",
    progress: "Updating",
  },
} as const satisfies Record<
  MigrateAction,
  {
    readonly button: string;
    readonly preparing: string;
    readonly progress: string;
  }
>;

const operationNeedsDependencyDecision = (
  operation: MigratePreparedOperation
): boolean =>
  operation.action !== "rollback" &&
  operation.plan.force !== true &&
  operation.dependencyChecks.some((dependency) => !dependency.satisfied);

const operationRollsBackOrphans = (
  operation: MigratePreparedOperation
): boolean =>
  operation.action === "run" && operation.plan.rollbackOrphans === true;

const preparedOperationCopy = (operation: MigratePreparedOperation) =>
  operationRollsBackOrphans(operation)
    ? {
        button: "rollback orphans",
        preparing: "Preparing to roll back orphans for",
        progress: "Rolling back orphans for",
      }
    : actionCopy[operation.action];

const forcedRollbackOptions = (
  operation: MigratePreparedOperation
): MigratePrepareOptions => ({
  ...(operation.plan.execution === undefined
    ? {}
    : { execution: operation.plan.execution }),
  force: true,
  ...(operation.sourceIdentities === undefined
    ? {}
    : { sourceIdentities: operation.sourceIdentities }),
  withDependencies: operation.plan.withDependencies,
});

type PlanHierarchyRow = MigratePreparedOperation["planRows"][number];

interface PlanHierarchyItem {
  readonly ancestorsAreLast: readonly boolean[];
  readonly depth: number;
  readonly executionStep?: number;
  readonly id: MigrateDashboardRow["entry"]["id"];
  readonly isLast: boolean;
  readonly relation?: "optional" | "required";
  readonly row?: PlanHierarchyRow;
}

const planHierarchyItems = (
  operation: MigratePreparedOperation
): readonly PlanHierarchyItem[] => {
  const rowsById = new Map(
    operation.planRows.map((row) => [row.entry.id, row])
  );

  for (const dependency of operation.dependencyChecks) {
    if (dependency.row !== undefined) {
      rowsById.set(dependency.dependencyId, dependency.row);
    }
  }

  const nodeIds = new Set(rowsById.keys());
  for (const dependency of operation.dependencyChecks) {
    nodeIds.add(dependency.dependencyId);
    nodeIds.add(dependency.requiredByDefinitionId);
  }

  const executionSteps = new Map(
    operation.plan.executionDefinitionIds.map((definitionId, index) => [
      definitionId,
      index + 1,
    ])
  );
  const executionPosition = (id: MigrateDashboardRow["entry"]["id"]): number =>
    executionSteps.get(id) ?? Number.MAX_SAFE_INTEGER;
  const children = new Map<
    MigrateDashboardRow["entry"]["id"],
    Map<MigrateDashboardRow["entry"]["id"], "optional" | "required">
  >();
  const addEdge = (
    dependentId: MigrateDashboardRow["entry"]["id"],
    dependencyId: MigrateDashboardRow["entry"]["id"],
    relation: "optional" | "required"
  ) => {
    if (!(nodeIds.has(dependentId) && nodeIds.has(dependencyId))) {
      return;
    }

    const parentId =
      operation.action === "rollback" ? dependencyId : dependentId;
    const childId =
      operation.action === "rollback" ? dependentId : dependencyId;
    const current = children.get(parentId) ?? new Map();
    current.set(childId, relation);
    children.set(parentId, current);
  };

  for (const row of rowsById.values()) {
    for (const dependencyId of row.entry.dependencies.required) {
      addEdge(row.entry.id, dependencyId, "required");
    }
    for (const dependencyId of row.entry.dependencies.optional) {
      addEdge(row.entry.id, dependencyId, "optional");
    }
  }

  for (const dependency of operation.dependencyChecks) {
    addEdge(
      dependency.requiredByDefinitionId,
      dependency.dependencyId,
      "required"
    );
  }

  const requestedIds =
    operation.plan.requestedDefinitionIds === "all"
      ? [...nodeIds]
      : operation.plan.requestedDefinitionIds.filter((id) => nodeIds.has(id));
  const childIds = new Set(
    [...children.values()].flatMap((entries) => [...entries.keys()])
  );
  const requestedRoots = requestedIds.filter((id) => !childIds.has(id));
  const roots = [
    ...(requestedRoots.length === 0 ? requestedIds : requestedRoots),
  ].sort((left, right) => executionPosition(left) - executionPosition(right));
  const items: PlanHierarchyItem[] = [];
  const visited = new Set<MigrateDashboardRow["entry"]["id"]>();
  const groupDepth = operation.selection.kind === "group" ? 1 : 0;

  const visit = (
    id: MigrateDashboardRow["entry"]["id"],
    relation: "optional" | "required" | undefined,
    depth: number,
    isLast: boolean,
    ancestorsAreLast: readonly boolean[]
  ) => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    const executionStep = executionSteps.get(id);
    const row = rowsById.get(id);

    items.push({
      ancestorsAreLast,
      depth,
      ...(executionStep === undefined ? {} : { executionStep }),
      id,
      isLast,
      ...(relation === undefined ? {} : { relation }),
      ...(row === undefined ? {} : { row }),
    });

    const nodeChildren = [...(children.get(id)?.entries() ?? [])].sort(
      ([left], [right]) => executionPosition(left) - executionPosition(right)
    );
    const childAncestors =
      depth === 0 ? ancestorsAreLast : [...ancestorsAreLast, isLast];

    nodeChildren.forEach(([childId, childRelation], index) => {
      visit(
        childId,
        childRelation,
        depth + 1,
        index === nodeChildren.length - 1,
        childAncestors
      );
    });
  };

  roots.forEach((rootId, index) => {
    visit(rootId, undefined, groupDepth, index === roots.length - 1, []);
  });

  const remainingIds = [...nodeIds]
    .filter((id) => !visited.has(id))
    .sort((left, right) => executionPosition(left) - executionPosition(right));
  remainingIds.forEach((id, index) => {
    visit(id, undefined, groupDepth, index === remainingIds.length - 1, []);
  });

  return items;
};

const hierarchyPrefix = (item: PlanHierarchyItem): string => {
  if (item.depth === 0) {
    return "";
  }

  return `${item.ancestorsAreLast
    .map((ancestorIsLast) => (ancestorIsLast ? "   " : "│  "))
    .join("")}${item.isLast ? "└─ " : "├─ "}`;
};

const PlanHierarchy = ({
  operation,
}: {
  readonly operation: MigratePreparedOperation;
}) => {
  const items = planHierarchyItems(operation);
  const hasGroupRoot = operation.selection.kind === "group";

  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height: items.length + (hasGroupRoot ? 1 : 0),
        width: "100%",
      }}
    >
      {hasGroupRoot ? (
        <box style={{ flexDirection: "row", flexShrink: 0, height: 1 }}>
          <text fg={colors.foreground}>
            {selectionLabel(operation.selection)}
          </text>
          <box style={{ flexGrow: 1 }} />
          <text fg={colors.dim}>GROUP</text>
        </box>
      ) : null}
      {items.map((item) => {
        const label =
          item.row === undefined
            ? "status unavailable"
            : migrationStatusLabel(item.row);
        const prefix = hierarchyPrefix(item);

        return (
          <box
            key={item.id}
            style={{ flexDirection: "row", flexShrink: 0, height: 1 }}
          >
            <text fg={colors.dim}>{prefix}</text>
            <text fg={migrationStatusColor(label)}>
              {migrationStatusIcon(label)}{" "}
            </text>
            <text fg={colors.foreground}>{item.id}</text>
            {item.executionStep === undefined ? null : (
              <text fg={colors.dim}> step {item.executionStep}</text>
            )}
            <box style={{ flexGrow: 1 }} />
            {item.relation === undefined ? null : (
              <text fg={colors.dim}>{item.relation} </text>
            )}
            <text fg={migrationStatusColor(label)}>{label.toUpperCase()}</text>
          </box>
        );
      })}
    </box>
  );
};

const SafetyDialog = ({
  height,
  onCancel,
  onForce,
  onConfirm,
  onIncludeDependencies,
  onKeyDown,
  operation,
  width,
}: {
  readonly height: number;
  readonly onCancel: () => void;
  readonly onForce: () => void;
  readonly onConfirm: () => void;
  readonly onIncludeDependencies: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly operation: MigratePreparedOperation;
  readonly width: number;
}) => {
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(76, width - (compact ? 8 : 4)));
  const hierarchyItems = planHierarchyItems(operation);
  const hierarchyRows =
    hierarchyItems.length + (operation.selection.kind === "group" ? 1 : 0);
  const dialogHeight = Math.max(
    1,
    Math.min(Math.max(11, hierarchyRows + 9), height - 4)
  );
  const hierarchyScrollable = hierarchyRows + 9 > dialogHeight;
  const dialogPadding = compact ? 1 : 2;
  const rollback = operation.action === "rollback";
  const rollbackOrphans = operationRollsBackOrphans(operation);
  const destructive = rollback || rollbackOrphans;
  const forcedRollback = rollback && operation.plan.force === true;
  let title = "Required dependencies not ready";
  let description = `${selectionLabel(operation.selection)} · Some required dependencies have not succeeded.`;
  let badgeLabel = "ACTION REQUIRED";
  let confirmationButtonLabel = "";
  let destructiveShortcut = "";

  if (rollback) {
    title = forcedRollback ? "Confirm forced rollback" : "Confirm rollback";
    description = forcedRollback
      ? `${selectionLabel(operation.selection)} · Dependent migration state checks will be bypassed. Step numbers show rollback order.`
      : `${selectionLabel(operation.selection)} · Step numbers show rollback execution order.`;
    badgeLabel = forcedRollback ? "FORCED" : "DESTRUCTIVE";
    confirmationButtonLabel = forcedRollback
      ? "y Force rollback"
      : "y Rollback";
    destructiveShortcut = forcedRollback
      ? "y force rollback"
      : "f force rollback · y rollback";
  } else if (rollbackOrphans) {
    title = "Confirm orphan rollback";
    description = `${selectionLabel(operation.selection)} · Destination items missing from the latest source inventory will be rolled back.`;
    badgeLabel = "DESTRUCTIVE";
    confirmationButtonLabel = "y Rollback orphans";
    destructiveShortcut = "y rollback orphans";
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open
    >
      <DialogContent
        backdropColor={RGBA.fromValues(0, 0, 0, 0.72)}
        backgroundColor={colors.surface}
        borderColor={destructive ? colors.danger : colors.warning}
        focusedBorderColor={destructive ? colors.danger : colors.warning}
        height={dialogHeight}
        maxWidth={dialogWidth}
        onKeyDown={onKeyDown}
        overflow="hidden"
        paddingLeft={dialogPadding}
        paddingRight={dialogPadding}
        width={dialogWidth}
      >
        <box
          style={{
            alignItems: "center",
            flexDirection: "row",
            flexShrink: 0,
            height: 1,
            justifyContent: "space-between",
            width: "100%",
          }}
        >
          <DialogTitle content={title} />
          <Badge
            intent={destructive ? "danger" : "warning"}
            label={badgeLabel}
          />
        </box>
        <DialogDescription content={description} wrapMode="none" />
        <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
          <text fg={colors.foreground}>
            {destructive ? "Affected migration hierarchy" : "Run order"}
          </text>
        </box>
        <scrollbox
          focusable={hierarchyScrollable}
          focused={hierarchyScrollable}
          scrollX={false}
          scrollY
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minHeight: 1,
            width: "100%",
          }}
          viewportCulling
        >
          <PlanHierarchy operation={operation} />
        </scrollbox>
        <box
          style={{
            flexDirection: "row-reverse",
            flexShrink: 0,
            gap: 1,
            height: 1,
            justifyContent: "flex-start",
            marginTop: 1,
          }}
        >
          {destructive ? (
            <>
              <Button
                intent="warning"
                label={confirmationButtonLabel}
                onPress={onConfirm}
              />
              {rollback && !forcedRollback ? (
                <Button
                  intent="warning"
                  label="f Force rollback"
                  onPress={onForce}
                />
              ) : null}
            </>
          ) : (
            <>
              <Button
                label="i Include dependencies"
                onPress={onIncludeDependencies}
              />
              <Button
                intent="warning"
                label={`f Force ${actionCopy[operation.action].button}`}
                onPress={onForce}
              />
            </>
          )}
          <Button intent="neutral" label="n Cancel" onPress={onCancel} />
        </box>
        <box
          style={{
            flexDirection: "row",
            flexShrink: 0,
            height: 1,
            justifyContent: "flex-end",
            width: "100%",
          }}
        >
          <text fg={colors.dim}>
            {hierarchyScrollable ? "↑↓ scroll · " : ""}
            {destructive
              ? `${destructiveShortcut} · n/esc cancel`
              : "i include · f force · n/esc cancel"}
          </text>
        </box>
      </DialogContent>
    </Dialog>
  );
};

export const MigrationTuiApp = ({
  initialRows,
  lifecycle,
  recoveryNotice,
  runtime,
}: {
  readonly initialRows?: readonly MigrateDashboardRow[];
  readonly lifecycle: MigrationTuiShutdownController;
  readonly recoveryNotice?: string;
  readonly runtime: MigrationTuiRuntime;
}) => {
  const dimensions = useTerminalDimensions();
  const [sourceScanStatuses, setSourceScanStatuses] = useState<
    ReadonlyMap<string, NonNullable<MigrateDashboardRow["status"]>>
  >(() => new Map());
  const [listTab, setListTab] = useState<MigrationListTab>("migrations");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [view, setView] = useState<View>("dashboard");
  const [pendingOperation, setPendingOperation] =
    useState<MigratePreparedOperation | null>(null);
  const [pendingLockRow, setPendingLockRow] =
    useState<MigrateDashboardRow | null>(null);
  const [selectiveAction, setSelectiveAction] = useState<"rollback" | "run">(
    "run"
  );
  const [detailTab, setDetailTab] = useState<MigrationDetailTab>("overview");
  const [messageIndex, setMessageIndex] = useState(0);
  const [busy, setBusyState] = useState(
    initialRows === undefined ? "Loading status…" : ""
  );
  const [notice, setNoticeState] = useState<string | null>(
    recoveryNotice ?? null
  );
  const [noticeTone, setNoticeTone] = useState<NoticeTone>("notice");
  const [error, setErrorState] = useState<string | null>(null);
  const [activity, setActivity] = useState(emptySessionActivity);
  const [activityIndex, setActivityIndex] = useState(0);
  const [activityDetailEntry, setActivityDetailEntry] =
    useState<SessionActivityEntry | null>(null);
  const [activityExportPath, setActivityExportPath] = useState("");
  const [activityExportError, setActivityExportError] = useState<
    string | undefined
  >();
  const [activityExportInputReady, setActivityExportInputReady] =
    useState(false);
  const [activityExportSaving, setActivityExportSaving] = useState(false);
  const activityFollowingRef = useRef(true);
  const activityOmittedRef = useRef(0);
  const sourceItemTotalsActivityErrorRef = useRef<string | null>(null);
  const appendActivity = useCallback(
    (input: Parameters<typeof appendSessionActivity>[1]) =>
      setActivity((current) => appendSessionActivity(current, input)),
    []
  );
  const setBusy = useCallback(
    (message: string) => {
      setBusyState(message);
      appendActivity({ kind: "status", message });
    },
    [appendActivity]
  );
  const setNotice = useCallback(
    (message: string | null) => {
      setNoticeState(message);
      if (message !== null) {
        setNoticeTone("notice");
        appendActivity({ kind: "notice", message });
      }
    },
    [appendActivity]
  );
  const setWarning = useCallback(
    (message: string) => {
      setNoticeState(message);
      setNoticeTone("warning");
      appendActivity({ kind: "warning", message });
    },
    [appendActivity]
  );
  const setStopResult = useCallback(
    (result: MigrateRunStopResult) => {
      const presentation = stopResultPresentation[result.kind];
      setNoticeState(result.message);
      setNoticeTone(presentation.noticeTone);
      appendActivity({
        kind: presentation.activityKind,
        message: result.message,
      });
    },
    [appendActivity]
  );
  const setRunObservationResult = useCallback(
    (result: MigrationTuiExecutionResult) => {
      const presentation = runObservationResultPresentation[result.outcome];
      setNoticeState(result.message);
      setNoticeTone(presentation.noticeTone);
      appendActivity({
        kind: presentation.activityKind,
        message: result.message,
      });
    },
    [appendActivity]
  );
  const setError = useCallback(
    (message: string | null) => {
      setErrorState(message);
      if (message !== null) {
        appendActivity({ kind: "error", message });
      }
    },
    [appendActivity]
  );
  const [selectiveTarget, setSelectiveTarget] = useState<Extract<
    MigrateTarget,
    { readonly kind: "migration" }
  > | null>(null);
  const [selectiveDraft, setSelectiveDraft] = useState("");
  const [selectiveEntriesByDefinition, setSelectiveEntriesByDefinition] =
    useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const [selectiveHistory, setSelectiveHistory] = useState<
    readonly MigrateSourceIdentityHistoryEntry[]
  >([]);
  const [selectiveHistoryIndex, setSelectiveHistoryIndex] = useState(0);
  const [selectiveHistoryLoading, setSelectiveHistoryLoading] = useState(false);
  const [selectiveInputReady, setSelectiveInputReady] = useState(false);
  const [selectiveFeedback, setSelectiveFeedback] = useState<
    | {
        readonly message: string;
        readonly tone: "error" | "info";
      }
    | undefined
  >();
  const [executionSettings, setExecutionSettings] =
    useState<MigrationTuiExecutionSettings>({});
  const [executionSettingsDrafts, setExecutionSettingsDrafts] =
    useState<MigrationTuiExecutionSettingsDrafts>({
      process: null,
      processUnbounded: false,
      rollback: null,
      rollbackUnbounded: false,
      sourceInventoryScan: null,
    });
  const [executionSettingsInputReady, setExecutionSettingsInputReady] =
    useState(false);
  const clearSourceScanStatuses = useCallback(
    () => setSourceScanStatuses(new Map()),
    []
  );
  const { activeRuns, durableRows, refresh } = useDashboardObservation({
    clearSourceScanStatuses,
    initialRows,
    recordActivity: appendActivity,
    recoveryNotice,
    runtime,
    setBusy,
    setError,
    setNotice,
  });
  const rows = useMemo(
    () =>
      durableRows.map((row) => {
        const sourceScanStatus = sourceScanStatuses.get(row.entry.id);

        if (sourceScanStatus === undefined) {
          return row;
        }
        if (row.status === undefined) {
          return { ...row, status: sourceScanStatus };
        }

        return {
          ...row,
          status: {
            ...row.status,
            ...(sourceScanStatus.source === undefined
              ? {}
              : { source: sourceScanStatus.source }),
            warnings: sourceScanStatus.warnings,
          },
        };
      }),
    [durableRows, sourceScanStatuses]
  );
  const selectedRow = rows[selectedIndex] ?? rows[0];
  const selectedGroup = runtime.groups[selectedIndex] ?? runtime.groups[0];
  const selectedDefinitionId = selectedRow?.entry.id;
  const selectedGroupId = selectedGroup?.id;
  const selectedGroupRows = useMemo(() => {
    if (selectedGroup === undefined) {
      return [];
    }

    const rowsById = new Map(rows.map((row) => [row.entry.id, row]));
    return selectedGroup.definitionIds.flatMap((definitionId) => {
      const row = rowsById.get(definitionId);
      return row === undefined ? [] : [row];
    });
  }, [rows, selectedGroup]);
  const selectedRows = useMemo(() => {
    if (listTab === "groups") {
      return selectedGroupRows;
    }

    return selectedRow === undefined ? [] : [selectedRow];
  }, [listTab, selectedGroupRows, selectedRow]);
  const selectedTarget = useMemo<MigrateTarget | undefined>(() => {
    if (listTab === "groups") {
      return selectedGroupId === undefined
        ? undefined
        : { groupId: selectedGroupId, kind: "group" };
    }

    return selectedDefinitionId === undefined
      ? undefined
      : { definitionId: selectedDefinitionId, kind: "migration" };
  }, [listTab, selectedDefinitionId, selectedGroupId]);
  const { loading: messagesLoading, messages } = useMigrationMessages({
    runtime,
    setError,
    target: selectedTarget,
  });
  const selectedSourceItemDefinitionIds = useMemo<
    readonly MigrationDefinitionId[]
  >(() => {
    if (selectedTarget === undefined) {
      return [];
    }
    if (selectedTarget.kind === "migration") {
      return [selectedTarget.definitionId];
    }

    return (
      runtime.groups.find((group) => group.id === selectedTarget.groupId)
        ?.definitionIds ?? []
    );
  }, [runtime, selectedTarget]);
  const selectedExactSourceItemDefinitionIds = useMemo(
    () =>
      selectedRows.flatMap((row) =>
        row.status?.source === undefined ? [] : [row.entry.id]
      ),
    [selectedRows]
  );
  const {
    clear: clearSourceItemTotalCache,
    failure: sourceItemTotalsFailure,
    totals: sourceItemTotals,
  } = useSourceItemTotals({
    definitionIds: selectedSourceItemDefinitionIds,
    exactDefinitionIds: selectedExactSourceItemDefinitionIds,
    runtime,
  });
  const refreshDashboard = useCallback(
    async (nextNotice?: string) => {
      clearSourceItemTotalCache();
      await refresh(nextNotice);
    },
    [clearSourceItemTotalCache, refresh]
  );
  const sourceItemTotalsError =
    sourceItemTotalsFailure === null
      ? null
      : `Unable to count source items: ${errorMessage(sourceItemTotalsFailure.cause)}`;
  const displayedError = error ?? sourceItemTotalsError;
  const selectedActiveRun = useMemo(() => {
    const matching = activeRuns.filter((run) =>
      selectedRows.some((row) => row.status?.lock?.ownerRunId === run.runId)
    );

    return matching.length === 1 ? matching[0] : undefined;
  }, [activeRuns, selectedRows]);
  const selectiveEntries = useMemo(
    () =>
      selectiveTarget === null
        ? []
        : (selectiveEntriesByDefinition.get(selectiveTarget.definitionId) ??
          []),
    [selectiveEntriesByDefinition, selectiveTarget]
  );
  const effectiveBusy = busy;
  const dashboardStateRef = useRef({
    busy: effectiveBusy,
    selectedRows,
    selectedTarget,
  });
  const messageStateRef = useRef({
    count: messages.length,
    selectedIndex: messageIndex,
  });
  const executingRef = useRef(false);
  const runObservationRef = useRef<
    | {
        readonly runId: MigrationRunId;
        readonly token: symbol;
      }
    | undefined
  >(undefined);
  const selectiveHistoryRequestRef = useRef(0);
  dashboardStateRef.current = {
    busy: effectiveBusy,
    selectedRows,
    selectedTarget,
  };
  messageStateRef.current = {
    count: messages.length,
    selectedIndex: messageIndex,
  };
  const scanSelectedSource = useCallback(
    async (targetOverride?: MigrateTarget) => {
      const target = targetOverride ?? dashboardStateRef.current.selectedTarget;

      if (target === undefined) {
        return;
      }

      setBusy(`Running Source Inventory Scan for ${targetLabel(target)}…`);
      setError(null);

      try {
        const snapshot = await runtime.scanSource(target, {
          ...(executionSettings.sourceInventoryScan === undefined
            ? {}
            : { concurrency: executionSettings.sourceInventoryScan }),
        });
        setSourceScanStatuses(
          new Map(
            snapshot.rows.flatMap((row) =>
              row.status === undefined ? [] : [[row.entry.id, row.status]]
            )
          )
        );
        setNotice(`Source Inventory Scan complete for ${targetLabel(target)}`);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy("");
      }
    },
    [
      executionSettings.sourceInventoryScan,
      runtime,
      setBusy,
      setError,
      setNotice,
    ]
  );

  const openMessages = useCallback(() => {
    setMessageIndex(0);
    setView("dashboard");
    setDetailTab("messages");
  }, []);

  const openBreakLock = useCallback(
    (rowOverride?: MigrateDashboardRow) => {
      const row = rowOverride ?? dashboardStateRef.current.selectedRows[0];

      if (row?.status?.lock == null) {
        return;
      }

      setError(null);
      setPendingLockRow(row);
      setView("break-lock");
    },
    [setError]
  );

  const startTask = useCallback(
    (task: Promise<unknown>) => {
      task.catch((cause: unknown) => setError(errorMessage(cause)));
    },
    [setError]
  );

  const refreshAfterExecutionFailure = useCallback(
    async (cause: unknown) => {
      const executionError = errorMessage(cause);
      await refresh();

      if (!lifecycle.isExitRequested()) {
        setError(executionError);
      }
    },
    [lifecycle, refresh, setError]
  );

  const executeOperation = useCallback(
    async (operation: MigratePreparedOperation) => {
      if (executingRef.current) {
        return;
      }

      executingRef.current = true;
      setView("dashboard");
      setPendingOperation(null);
      setSourceScanStatuses(new Map());
      setNotice(null);
      setBusy(
        `${preparedOperationCopy(operation).progress} ${selectionLabel(operation.selection)}…`
      );
      setError(null);

      try {
        const reference = await runtime.start(operation);
        setNotice(
          reference.status === "completed"
            ? `Run ${reference.runId} completed`
            : `Run ${reference.runId} started`
        );
        setBusy("");
      } catch (cause) {
        if (lifecycle.isExitRequested()) {
          return;
        }

        await refreshAfterExecutionFailure(cause);
      } finally {
        executingRef.current = false;
        lifecycle.executionSettled();
      }
    },
    [
      lifecycle,
      refreshAfterExecutionFailure,
      runtime,
      setBusy,
      setError,
      setNotice,
    ]
  );

  const observeActiveRun = useCallback(
    async (runId: MigrationRunId) => {
      if (lifecycle.isExitRequested()) {
        return;
      }

      if (runObservationRef.current?.runId === runId) {
        return;
      }

      runtime.detachRunObservation();
      const token = Symbol("MigrationTuiRunObservation");
      runObservationRef.current = { runId, token };
      setView("dashboard");
      setError(null);

      try {
        const result = await runtime.observeRun(runId, {
          onObservationWarning: setWarning,
          onProgressError: (cause) => {
            setError(`Unable to refresh live status: ${errorMessage(cause)}`);
          },
        });

        if (
          lifecycle.isExitRequested() ||
          runObservationRef.current?.token !== token
        ) {
          return;
        }

        setRunObservationResult(result);
      } catch (cause) {
        if (
          lifecycle.isExitRequested() ||
          runObservationRef.current?.token !== token
        ) {
          return;
        }

        await refreshAfterExecutionFailure(cause);
      } finally {
        if (runObservationRef.current?.token === token) {
          runObservationRef.current = undefined;
          lifecycle.executionSettled();
        }
      }
    },
    [
      lifecycle,
      refreshAfterExecutionFailure,
      runtime,
      setError,
      setRunObservationResult,
      setWarning,
    ]
  );

  const stopRun = useCallback(
    async (runId: MigrationRunId) => {
      setView("dashboard");
      setBusy(`Stopping run ${runId}…`);
      setError(null);

      try {
        const result = await runtime.stopRun(runId);
        setStopResult(result);
        setBusy("");
      } catch (cause) {
        setError(errorMessage(cause));
        setBusy("");
      }
    },
    [runtime, setBusy, setError, setStopResult]
  );

  const prepareOperation = useCallback(
    async (
      action: MigrateAction,
      options: MigratePrepareOptions = {},
      selectionOverride?: MigrateSelection
    ) => {
      const selectedTarget = dashboardStateRef.current.selectedTarget;
      const selection =
        selectionOverride ??
        (selectedTarget === undefined
          ? undefined
          : selectionFromTarget(selectedTarget));

      if (selection === undefined || lifecycle.isExitRequested()) {
        return;
      }

      setPendingOperation(null);
      setView("dashboard");
      setBusy(
        `${options.rollbackOrphans === true ? "Preparing to roll back orphans for" : actionCopy[action].preparing} ${selectionLabel(selection)}…`
      );
      setError(null);

      try {
        const execution = migrationExecutionOptions(executionSettings);
        const operation = await runtime.prepare(selection, action, {
          ...options,
          ...(execution === undefined ? {} : { execution }),
        });

        if (lifecycle.isExitRequested()) {
          return;
        }

        if (
          operation.action === "rollback" ||
          operationRollsBackOrphans(operation) ||
          operationNeedsDependencyDecision(operation)
        ) {
          setBusy("");
          setPendingOperation(operation);
          setView("confirm");
          return;
        }

        await executeOperation(operation);
      } catch (cause) {
        setError(errorMessage(cause));
        setBusy("");
      }
    },
    [executeOperation, executionSettings, lifecycle, runtime, setBusy, setError]
  );

  const openSelectiveEntries = useCallback(
    (action: "rollback" | "run", targetOverride?: MigrateTarget) => {
      const target = targetOverride ?? dashboardStateRef.current.selectedTarget;

      if (target?.kind !== "migration") {
        return;
      }

      setSelectiveAction(action);
      setSelectiveTarget(target);
      setSelectiveDraft("");
      setSelectiveFeedback(undefined);
      setSelectiveHistory([]);
      setSelectiveHistoryIndex(0);
      setSelectiveHistoryLoading(true);
      setSelectiveInputReady(false);
      setError(null);
      setView(action === "rollback" ? "selective-rollback" : "selective-run");
      const requestId = selectiveHistoryRequestRef.current + 1;
      selectiveHistoryRequestRef.current = requestId;

      runtime
        .listSourceIdentityHistory(target.definitionId)
        .then((history) => {
          if (selectiveHistoryRequestRef.current !== requestId) {
            return;
          }
          setSelectiveHistory(history);
          setSelectiveHistoryIndex(0);
        })
        .catch((cause: unknown) => {
          if (selectiveHistoryRequestRef.current !== requestId) {
            return;
          }
          setSelectiveFeedback({
            message: errorMessage(cause),
            tone: "error",
          });
        })
        .finally(() => {
          if (selectiveHistoryRequestRef.current === requestId) {
            setSelectiveHistoryLoading(false);
          }
        });
    },
    [runtime, setError]
  );

  const cancelSelectiveRun = useCallback(() => {
    selectiveHistoryRequestRef.current += 1;
    setSelectiveTarget(null);
    setSelectiveDraft("");
    setSelectiveFeedback(undefined);
    setSelectiveInputReady(false);
    setView("dashboard");
  }, []);

  const confirmSelectiveEntries = useCallback(() => {
    const target = selectiveTarget;

    if (target === null) {
      return;
    }

    if (selectiveEntries.length === 0) {
      setSelectiveFeedback({
        message: "Add at least one source identity.",
        tone: "error",
      });
      return;
    }

    startTask(
      prepareOperation(
        selectiveAction,
        {
          sourceIdentities: selectiveEntries,
          ...(selectiveAction === "rollback"
            ? { withDependencies: false }
            : {}),
        },
        selectionFromTarget(target)
      )
    );
  }, [
    prepareOperation,
    selectiveAction,
    selectiveEntries,
    selectiveTarget,
    startTask,
  ]);

  const submitSelectiveEntry = useCallback(
    async (value: string) => {
      const target = selectiveTarget;
      const sourceIdentity = value.trim();

      if (target === null) {
        return;
      }

      if (sourceIdentity === "") {
        confirmSelectiveEntries();
        return;
      }

      try {
        const normalized = await runtime.normalizeSourceIdentity(
          target.definitionId,
          sourceIdentity
        );

        if (selectiveEntries.includes(normalized)) {
          setSelectiveDraft("");
          setSelectiveFeedback({
            message: `${normalized} is already selected.`,
            tone: "info",
          });
          return;
        }

        setSelectiveEntriesByDefinition((current) => {
          const next = new Map(current);
          next.set(target.definitionId, [...selectiveEntries, normalized]);
          return next;
        });
        setSelectiveDraft("");
        setSelectiveFeedback({
          message: `Added ${normalized}.`,
          tone: "info",
        });
      } catch (cause) {
        setSelectiveFeedback({
          message: errorMessage(cause),
          tone: "error",
        });
      }
    },
    [confirmSelectiveEntries, runtime, selectiveEntries, selectiveTarget]
  );

  const toggleSelectiveHistoryEntry = useCallback(() => {
    const target = selectiveTarget;
    const historyEntry = selectiveHistory[selectiveHistoryIndex];

    if (target === null || historyEntry === undefined) {
      return;
    }

    const selected = selectiveEntries.includes(historyEntry.sourceIdentity);
    const nextEntries = selected
      ? selectiveEntries.filter(
          (sourceIdentity) => sourceIdentity !== historyEntry.sourceIdentity
        )
      : [...selectiveEntries, historyEntry.sourceIdentity];
    setSelectiveEntriesByDefinition((current) => {
      const next = new Map(current);
      next.set(target.definitionId, nextEntries);
      return next;
    });
    setSelectiveFeedback({
      message: selected
        ? `Removed ${historyEntry.sourceIdentity}.`
        : `Added ${historyEntry.sourceIdentity}.`,
      tone: "info",
    });
  }, [
    selectiveEntries,
    selectiveHistory,
    selectiveHistoryIndex,
    selectiveTarget,
  ]);

  const handleSelectiveRunKey = useCallback(
    (key: KeyEvent) => {
      if (!selectiveInputReady) {
        if (key.name === "return" || key.name === "linefeed") {
          key.preventDefault();
          key.stopPropagation();
        }
        return;
      }

      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        cancelSelectiveRun();
      } else if (key.name === "up" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        setSelectiveHistoryIndex((index) => {
          if (selectiveHistory.length === 0) {
            return 0;
          }

          const offset = key.name === "up" ? -1 : 1;
          return (
            (index + offset + selectiveHistory.length) % selectiveHistory.length
          );
        });
      } else if (
        (key.name === "space" || key.sequence === " ") &&
        selectiveDraft === ""
      ) {
        key.preventDefault();
        key.stopPropagation();
        toggleSelectiveHistoryEntry();
      } else if (key.ctrl && key.name === "backspace") {
        key.preventDefault();
        key.stopPropagation();

        if (selectiveTarget !== null && selectiveEntries.length > 0) {
          const removed = selectiveEntries.at(-1);
          setSelectiveEntriesByDefinition((current) => {
            const next = new Map(current);
            next.set(
              selectiveTarget.definitionId,
              selectiveEntries.slice(0, -1)
            );
            return next;
          });
          setSelectiveFeedback({
            message: `Removed ${removed}.`,
            tone: "info",
          });
        }
      }
    },
    [
      cancelSelectiveRun,
      selectiveDraft,
      selectiveEntries,
      selectiveHistory.length,
      selectiveInputReady,
      selectiveTarget,
      toggleSelectiveHistoryEntry,
    ]
  );

  const openExecutionSettings = useCallback(() => {
    const process = pipelineConcurrencyDraft(executionSettings.process);
    const rollback = pipelineConcurrencyDraft(executionSettings.rollback);

    setExecutionSettingsDrafts({
      process: process.value,
      processUnbounded: process.unbounded,
      rollback: rollback.value,
      rollbackUnbounded: rollback.unbounded,
      sourceInventoryScan: executionSettings.sourceInventoryScan ?? null,
    });
    setExecutionSettingsInputReady(false);
    setView("execution-settings");
  }, [executionSettings]);

  const cancelExecutionSettings = useCallback(() => {
    setExecutionSettingsInputReady(false);
    setView("actions");
  }, []);

  const saveExecutionSettings = useCallback(() => {
    const process = executionSettingsDrafts.processUnbounded
      ? "unbounded"
      : (executionSettingsDrafts.process ?? undefined);
    const rollback = executionSettingsDrafts.rollbackUnbounded
      ? "unbounded"
      : (executionSettingsDrafts.rollback ?? undefined);
    const sourceInventoryScan =
      executionSettingsDrafts.sourceInventoryScan ?? undefined;

    setExecutionSettings({
      ...(process === undefined ? {} : { process }),
      ...(rollback === undefined ? {} : { rollback }),
      ...(sourceInventoryScan === undefined ? {} : { sourceInventoryScan }),
    });
    setExecutionSettingsInputReady(false);
    setNotice("Concurrency settings saved for this session");
    setView("actions");
  }, [executionSettingsDrafts, setNotice]);

  const handleExecutionSettingsKey = useCallback(
    (key: KeyEvent) => {
      if (!executionSettingsInputReady) {
        return;
      }

      if (key.ctrl && key.name === "s") {
        key.preventDefault();
        key.stopPropagation();
        saveExecutionSettings();
      } else if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        cancelExecutionSettings();
      }
    },
    [
      cancelExecutionSettings,
      executionSettingsInputReady,
      saveExecutionSettings,
    ]
  );

  const chooseOption = useCallback(
    (option: MigrationTuiAvailableAction | undefined) => {
      if (option === undefined) {
        return;
      }

      if (option.view === "messages") {
        openMessages();
        return;
      }

      if (option.view === "view-run" && option.runId !== undefined) {
        startTask(observeActiveRun(option.runId));
        return;
      }

      if (option.view === "stop-run" && option.runId !== undefined) {
        startTask(stopRun(option.runId));
        return;
      }

      if (option.view === "scan") {
        setView("dashboard");
        startTask(scanSelectedSource());
        return;
      }

      if (option.view === "execution-settings") {
        openExecutionSettings();
        return;
      }

      if (
        option.view === "selective-run" ||
        option.view === "selective-rollback"
      ) {
        openSelectiveEntries(
          option.view === "selective-rollback" ? "rollback" : "run"
        );
        return;
      }

      if (option.view === "break-lock") {
        openBreakLock();
        return;
      }

      if (option.action !== undefined) {
        startTask(prepareOperation(option.action, option.options));
      }
    },
    [
      openBreakLock,
      openExecutionSettings,
      openMessages,
      openSelectiveEntries,
      observeActiveRun,
      prepareOperation,
      scanSelectedSource,
      startTask,
      stopRun,
    ]
  );

  const selectedActions = useMemo(
    () =>
      selectedTarget === undefined
        ? []
        : migrationTuiAvailableActions(
            selectedTarget,
            selectedRows,
            activeRuns
          ),
    [activeRuns, selectedRows, selectedTarget]
  );

  const openActivity = useCallback(() => {
    activityFollowingRef.current = true;
    setActivityDetailEntry(null);
    setActivityIndex(Math.max(0, activity.entries.length - 1));
    setView("activity");
  }, [activity.entries.length]);

  const closeActivityDetail = useCallback(() => {
    setActivityDetailEntry(null);
    setView("activity");
  }, []);

  const openActivityExport = useCallback(() => {
    setActivityExportPath(defaultSessionActivityExportPath());
    setActivityExportError(undefined);
    setActivityExportInputReady(false);
    setActivityExportSaving(false);
    setView("activity-export");
  }, []);

  const cancelActivityExport = useCallback(() => {
    setActivityExportError(undefined);
    setActivityExportInputReady(false);
    setActivityExportSaving(false);
    setView("activity");
  }, []);

  const saveActivityExport = useCallback(async () => {
    if (activityExportSaving) {
      return;
    }

    setActivityExportError(undefined);
    setActivityExportSaving(true);

    try {
      const outputPath = await exportSessionActivity(
        activity.entries,
        activityExportPath
      );
      setActivityExportInputReady(false);
      setView("activity");
      setNotice(
        `Exported ${activity.entries.length} session ${activity.entries.length === 1 ? "event" : "events"} to ${outputPath}`
      );
    } catch (cause) {
      const message = errorMessage(cause);
      setActivityExportError(message);
      appendActivity({ kind: "error", message });
    } finally {
      setActivityExportSaving(false);
    }
  }, [
    activity.entries,
    activityExportPath,
    activityExportSaving,
    appendActivity,
    setNotice,
  ]);

  const handleActivityKey = useCallback(
    (key: KeyEvent) => {
      handleSessionActivityKey(key, {
        count: activity.entries.length,
        index: activityIndex,
        onBack: () => setView("dashboard"),
        onExpand: () => {
          const entry = activity.entries[activityIndex];

          if (entry === undefined) {
            return;
          }

          activityFollowingRef.current = false;
          setActivityDetailEntry(entry);
          setView("activity-detail");
        },
        onExport: openActivityExport,
        onSelectionChange: (index, following) => {
          activityFollowingRef.current = following;
          setActivityIndex(index);
        },
      });
    },
    [activity.entries, activityIndex, openActivityExport]
  );

  const handleActivityExportKey = useCallback(
    (key: KeyEvent) => {
      handleSessionActivityExportKey(
        key,
        activityExportInputReady,
        cancelActivityExport,
        () => startTask(saveActivityExport())
      );
    },
    [
      activityExportInputReady,
      cancelActivityExport,
      saveActivityExport,
      startTask,
    ]
  );

  useEffect(() => {
    const runId = selectedActiveRun?.runId;

    if (runId === undefined) {
      runObservationRef.current = undefined;
      runtime.detachRunObservation();
      return;
    }

    startTask(observeActiveRun(runId));

    return () => {
      if (runObservationRef.current?.runId === runId) {
        runObservationRef.current = undefined;
      }
      runtime.detachRunObservation(runId);
    };
  }, [observeActiveRun, runtime, selectedActiveRun?.runId, startTask]);

  useEffect(() => {
    if (view !== "selective-run" && view !== "selective-rollback") {
      return;
    }

    const timer = setTimeout(() => setSelectiveInputReady(true), 100);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (view !== "execution-settings") {
      return;
    }

    const timer = setTimeout(() => setExecutionSettingsInputReady(true), 100);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (view !== "activity-export") {
      return;
    }

    const timer = setTimeout(() => setActivityExportInputReady(true), 100);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    const previousOmitted = activityOmittedRef.current;
    const omittedDelta = Math.max(0, activity.omitted - previousOmitted);
    activityOmittedRef.current = activity.omitted;
    const entries = activity.entries;
    setActivityIndex((current) => {
      if (activityFollowingRef.current) {
        return Math.max(0, entries.length - 1);
      }

      return Math.min(
        Math.max(0, current - omittedDelta),
        Math.max(0, entries.length - 1)
      );
    });
  }, [activity.entries, activity.omitted]);

  useEffect(() => {
    if (
      sourceItemTotalsError !== null &&
      sourceItemTotalsError !== sourceItemTotalsActivityErrorRef.current
    ) {
      appendActivity({ kind: "error", message: sourceItemTotalsError });
    }
    sourceItemTotalsActivityErrorRef.current = sourceItemTotalsError;
  }, [appendActivity, sourceItemTotalsError]);

  useEffect(() => {
    if (selectedTarget !== undefined) {
      setMessageIndex(0);
    }
  }, [selectedTarget]);

  const cancelConfirmation = useCallback(() => {
    setPendingOperation(null);
    setView("dashboard");
  }, []);

  const cancelBreakLock = useCallback(() => {
    setPendingLockRow(null);
    setView("dashboard");
  }, []);

  const executeBreakLock = useCallback(async () => {
    const row = pendingLockRow;

    if (row === null) {
      return;
    }

    setPendingLockRow(null);
    setView("dashboard");
    setBusy(`Breaking lock for ${row.entry.id}…`);
    setError(null);

    try {
      const lock = row.status?.lock;

      if (lock == null) {
        await refreshDashboard(`${row.entry.id} no longer has an active lock`);
        return;
      }

      const result = await runtime.breakLock(lock);
      await refreshDashboard(
        result.kind === "already-clear"
          ? `${row.entry.id} no longer has an active lock`
          : `Lock cleared for ${row.entry.id}`
      );
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy("");
    }
  }, [pendingLockRow, refreshDashboard, runtime, setBusy, setError]);

  const handleBreakLockKey = useCallback(
    (key: KeyEvent) => {
      key.preventDefault();
      key.stopPropagation();

      if (key.name === "n" || key.name === "escape") {
        cancelBreakLock();
      } else if (key.name === "y") {
        startTask(executeBreakLock());
      }
    },
    [cancelBreakLock, executeBreakLock, startTask]
  );

  const handleConfirmationKey = useCallback(
    (key: KeyEvent) => {
      const operation = pendingOperation;

      key.preventDefault();
      key.stopPropagation();

      if (key.name === "n" || key.name === "escape") {
        cancelConfirmation();
      } else if (
        operation !== null &&
        (operation.action === "rollback" ||
          operationRollsBackOrphans(operation)) &&
        key.name === "y"
      ) {
        startTask(executeOperation(operation));
      } else if (
        operation !== null &&
        operation.action === "rollback" &&
        operation.plan.force !== true &&
        key.name === "f"
      ) {
        startTask(
          prepareOperation(
            operation.action,
            forcedRollbackOptions(operation),
            operation.selection
          )
        );
      } else if (
        operation !== null &&
        operation.action !== "rollback" &&
        key.name === "i"
      ) {
        startTask(
          prepareOperation(
            operation.action,
            {
              ...(operation.sourceIdentities === undefined
                ? {}
                : { sourceIdentities: operation.sourceIdentities }),
              withDependencies: true,
            },
            operation.selection
          )
        );
      } else if (
        operation !== null &&
        operation.action !== "rollback" &&
        key.name === "f"
      ) {
        startTask(
          prepareOperation(
            operation.action,
            {
              force: true,
              ...(operation.sourceIdentities === undefined
                ? {}
                : { sourceIdentities: operation.sourceIdentities }),
              withDependencies: false,
            },
            operation.selection
          )
        );
      }
    },
    [
      cancelConfirmation,
      executeOperation,
      pendingOperation,
      prepareOperation,
      startTask,
    ]
  );

  const handleActionsKey = useCallback(
    (key: KeyEvent) => {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        setView("dashboard");
      } else {
        const option = migrationTuiActionForKey(selectedActions, key.name);

        if (option !== undefined) {
          key.preventDefault();
          key.stopPropagation();
          chooseOption(option);
        }
      }
    },
    [chooseOption, selectedActions]
  );

  const handleDashboardKey = useCallback(
    (key: KeyEvent) => {
      const state = dashboardStateRef.current;
      const target = state.selectedTarget;

      if (state.busy !== "" || target === undefined) {
        return;
      }

      if (key.name === "r" && key.shift) {
        startTask(refreshDashboard());
        return;
      }

      const option = migrationTuiActionForKey(
        migrationTuiAvailableActions(target, state.selectedRows, activeRuns),
        key.name
      );

      if (option !== undefined) {
        key.preventDefault();
        key.stopPropagation();
        chooseOption(option);
      }
    },
    [activeRuns, chooseOption, refreshDashboard, startTask]
  );

  const requestExit = useCallback(async () => {
    try {
      const cancellation = await lifecycle.requestExit();

      if (cancellation.kind !== "idle") {
        setBusy(cancellation.message);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy("");
    }
  }, [lifecycle, setBusy, setError]);

  const changeListTab = useCallback(
    (nextTab: MigrationListTab) => {
      if (nextTab === "groups" && runtime.groups.length === 0) {
        return;
      }

      setListTab(nextTab);
      setSelectedIndex(0);
      setDetailTab("overview");
    },
    [runtime.groups.length]
  );

  const handleOverviewKey = useCallback(
    (key: KeyEvent) => {
      const visibleCount =
        listTab === "groups" ? runtime.groups.length : rows.length;

      if (key.name === "g") {
        changeListTab(listTab === "groups" ? "migrations" : "groups");
      } else if (key.name === "up" || key.name === "k") {
        setSelectedIndex((index) =>
          visibleCount === 0 ? 0 : (index - 1 + visibleCount) % visibleCount
        );
      } else if (key.name === "down" || key.name === "j") {
        setSelectedIndex((index) =>
          visibleCount === 0 ? 0 : (index + 1) % visibleCount
        );
      } else if (key.name === "m") {
        openMessages();
      } else if (dashboardStateRef.current.busy !== "") {
        return;
      } else if (key.name === "return" || key.name === "linefeed") {
        key.preventDefault();
        key.stopPropagation();
        setActionIndex(0);
        setView("actions");
      } else {
        handleDashboardKey(key);
      }
    },
    [
      changeListTab,
      handleDashboardKey,
      listTab,
      openMessages,
      rows.length,
      runtime.groups.length,
    ]
  );

  const handleMessageKey = useCallback((key: KeyEvent): boolean => {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      setDetailTab("overview");
      return true;
    }

    const state = messageStateRef.current;
    if ((key.name === "return" || key.name === "linefeed") && state.count > 0) {
      key.preventDefault();
      key.stopPropagation();
      setView("message-detail");
      return true;
    }

    const nextIndex = nextListSelection(
      key.name,
      state.selectedIndex,
      state.count
    );

    if (nextIndex === undefined) {
      return false;
    }

    key.preventDefault();
    key.stopPropagation();
    setMessageIndex(nextIndex);
    return true;
  }, []);

  useKeyboard((key) => {
    if (
      view === "break-lock" &&
      (key.name === "y" || key.name === "n" || key.name === "escape")
    ) {
      handleBreakLockKey(key);
    } else if (
      view === "confirm" &&
      (key.name === "f" ||
        key.name === "i" ||
        key.name === "y" ||
        key.name === "n" ||
        key.name === "escape")
    ) {
      handleConfirmationKey(key);
    } else if (view === "dashboard" && key.name === "l") {
      key.preventDefault();
      key.stopPropagation();
      openActivity();
    } else if (
      view === "dashboard" &&
      detailTab === "messages" &&
      handleMessageKey(key)
    ) {
      return;
    } else if (view === "execution-settings") {
      handleExecutionSettingsKey(key);
    } else if (view === "selective-run" || view === "selective-rollback") {
      handleSelectiveRunKey(key);
    } else if (view === "activity-export") {
      handleActivityExportKey(key);
    } else if (view === "activity" && key.name !== "q") {
      handleActivityKey(key);
    } else if (key.name === "q") {
      startTask(requestExit());
    } else if (view === "dashboard" && detailTab === "overview") {
      handleOverviewKey(key);
    }
  });

  if (isSessionActivityView(view)) {
    return (
      <SessionActivityView
        activity={activity}
        detailEntry={activityDetailEntry}
        environmentLabel={runtime.environmentLabel}
        {...(activityExportError === undefined
          ? {}
          : { exportError: activityExportError })}
        exportInputReady={activityExportInputReady}
        exportPath={activityExportPath}
        exportSaving={activityExportSaving}
        height={dimensions.height}
        mode={view}
        onCancelExport={cancelActivityExport}
        onCloseDetail={closeActivityDetail}
        onExport={() => startTask(saveActivityExport())}
        onExportKeyDown={handleActivityExportKey}
        onExportPathChange={(path) => {
          setActivityExportError(undefined);
          setActivityExportPath(path);
        }}
        selectedIndex={activityIndex}
        width={dimensions.width}
      />
    );
  }

  if (selectedRow === undefined) {
    return (
      <box
        style={{
          alignItems: "center",
          backgroundColor: colors.background,
          height: dimensions.height,
          justifyContent: "center",
        }}
      >
        <text fg={colors.dim}>No migrations found in this config.</text>
      </box>
    );
  }

  if (view === "actions") {
    return (
      <box
        style={{
          backgroundColor: colors.background,
          flexDirection: "column",
          height: dimensions.height,
          padding: 1,
        }}
      >
        <text fg={colors.foreground}>
          All actions ·{" "}
          {selectedTarget === undefined ? "" : targetLabel(selectedTarget)}
        </text>
        <box
          style={{
            border: true,
            borderColor: colors.info,
            flexGrow: 1,
            marginTop: 1,
            padding: 1,
          }}
        >
          <select
            focused
            onChange={(index) => setActionIndex(index)}
            onKeyDown={handleActionsKey}
            onSelect={(index) => chooseOption(selectedActions[index])}
            options={selectedActions.map((option) => ({
              description: option.description,
              name:
                option.key === ""
                  ? option.label
                  : `${option.label}  [${option.key}]`,
              value: option.action ?? option.view,
            }))}
            selectedIndex={actionIndex}
            showScrollIndicator
            style={{
              backgroundColor: colors.background,
              focusedBackgroundColor: colors.background,
              height: "100%",
              selectedBackgroundColor: colors.selected,
              selectedTextColor: colors.foreground,
            }}
            wrapSelection
          />
        </box>
        <text fg={colors.dim}>↑/↓ choose · enter open · esc back</text>
      </box>
    );
  }

  return (
    <box
      style={{
        backgroundColor: colors.background,
        flexDirection: "column",
        height: dimensions.height,
        padding: 1,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          height: 1,
          justifyContent: "space-between",
          width: "100%",
        }}
      >
        <text fg={colors.foreground}>Migrate</text>
        <text fg={colors.dim}>{runtime.environmentLabel}</text>
      </box>
      <MigrationDashboard
        actions={selectedActions}
        activeTab={detailTab}
        busy={effectiveBusy}
        groups={runtime.groups}
        listTab={listTab}
        messageIndex={messageIndex}
        messages={messages}
        messagesLoading={messagesLoading}
        onListTabChange={changeListTab}
        onMessageIndexChange={setMessageIndex}
        onOpenActions={() => {
          setActionIndex(0);
          setView("actions");
        }}
        onSelectAction={chooseOption}
        onSelectCurrent={() => {
          if (dashboardStateRef.current.busy === "") {
            setActionIndex(0);
            setView("actions");
          }
        }}
        onSelectedIndexChange={setSelectedIndex}
        onTabChange={setDetailTab}
        rows={rows}
        selectedIndex={selectedIndex}
        sourceItemTotals={sourceItemTotals}
        terminalWidth={dimensions.width}
      />
      <box
        style={{
          flexDirection: "column",
          flexShrink: 0,
          height:
            effectiveBusy !== "" && (displayedError !== null || notice !== null)
              ? 2
              : 1,
        }}
      >
        {effectiveBusy === "" ? null : (
          <text fg={colors.info}>{effectiveBusy}</text>
        )}
        {displayedError === null ? null : (
          <text fg={colors.danger}>{displayedError}</text>
        )}
        {displayedError !== null || notice === null ? null : (
          <text fg={noticeColor(noticeTone)}>{notice}</text>
        )}
      </box>
      {view === "confirm" && pendingOperation !== null ? (
        <SafetyDialog
          height={dimensions.height}
          onCancel={cancelConfirmation}
          onConfirm={() => {
            if (
              pendingOperation.action === "rollback" ||
              operationRollsBackOrphans(pendingOperation)
            ) {
              startTask(executeOperation(pendingOperation));
            }
          }}
          onForce={() => {
            if (
              pendingOperation.action === "rollback" &&
              pendingOperation.plan.force !== true
            ) {
              startTask(
                prepareOperation(
                  pendingOperation.action,
                  forcedRollbackOptions(pendingOperation),
                  pendingOperation.selection
                )
              );
            } else if (pendingOperation.action !== "rollback") {
              startTask(
                prepareOperation(
                  pendingOperation.action,
                  {
                    force: true,
                    ...(pendingOperation.sourceIdentities === undefined
                      ? {}
                      : {
                          sourceIdentities: pendingOperation.sourceIdentities,
                        }),
                    withDependencies: false,
                  },
                  pendingOperation.selection
                )
              );
            }
          }}
          onIncludeDependencies={() => {
            if (pendingOperation.action !== "rollback") {
              startTask(
                prepareOperation(
                  pendingOperation.action,
                  {
                    ...(pendingOperation.sourceIdentities === undefined
                      ? {}
                      : {
                          sourceIdentities: pendingOperation.sourceIdentities,
                        }),
                    withDependencies: true,
                  },
                  pendingOperation.selection
                )
              );
            }
          }}
          onKeyDown={handleConfirmationKey}
          operation={pendingOperation}
          width={dimensions.width}
        />
      ) : null}
      {view === "break-lock" && pendingLockRow?.status?.lock != null ? (
        <BreakLockDialog
          height={dimensions.height}
          lock={pendingLockRow.status.lock}
          onCancel={cancelBreakLock}
          onConfirm={() => startTask(executeBreakLock())}
          onKeyDown={handleBreakLockKey}
          width={dimensions.width}
        />
      ) : null}
      {view === "message-detail" && messages[messageIndex] !== undefined ? (
        <MessageDetailDialog
          height={dimensions.height}
          index={messageIndex}
          message={messages[messageIndex]}
          onClose={() => setView("dashboard")}
          showDefinitionId={selectedTarget?.kind === "group"}
          total={messages.length}
          width={dimensions.width}
        />
      ) : null}
      {view === "execution-settings" ? (
        <ExecutionSettingsDialog
          drafts={executionSettingsDrafts}
          height={dimensions.height}
          inputReady={executionSettingsInputReady}
          onCancel={cancelExecutionSettings}
          onKeyDown={handleExecutionSettingsKey}
          onSave={saveExecutionSettings}
          onUnboundedChange={(field, checked) => {
            setExecutionSettingsDrafts((current) => ({
              ...current,
              [field]: checked,
            }));
          }}
          onValueChange={(field, value) => {
            setExecutionSettingsDrafts((current) => ({
              ...current,
              [field]: value,
            }));
          }}
          width={dimensions.width}
        />
      ) : null}
      {(view === "selective-run" || view === "selective-rollback") &&
      selectiveTarget !== null ? (
        <SelectiveRunDialog
          action={selectiveAction}
          definitionId={selectiveTarget.definitionId}
          draft={selectiveDraft}
          entries={selectiveEntries}
          {...(selectiveFeedback === undefined
            ? {}
            : { feedback: selectiveFeedback })}
          height={dimensions.height}
          history={selectiveHistory}
          historyIndex={selectiveHistoryIndex}
          historyLoading={selectiveHistoryLoading}
          inputReady={selectiveInputReady}
          onCancel={cancelSelectiveRun}
          onConfirm={confirmSelectiveEntries}
          onDraftChange={setSelectiveDraft}
          onKeyDown={handleSelectiveRunKey}
          onSubmit={submitSelectiveEntry}
          width={dimensions.width}
        />
      ) : null}
    </box>
  );
};
