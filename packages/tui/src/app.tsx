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
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import type { MigrationTuiRuntime } from "./runtime.ts";
import type { MigrationTuiShutdownController } from "./shutdown-controller.ts";
import { useDashboardObservation } from "./use-dashboard-observation.ts";
import { useMigrationMessages } from "./use-migration-messages.ts";
import { useSourceItemTotals } from "./use-source-item-totals.ts";

type View =
  | "actions"
  | "break-lock"
  | "confirm"
  | "dashboard"
  | "execution-settings"
  | "message-detail"
  | "selective-run";

interface MigrationTuiExecutionSettings {
  readonly process?: PipelineExecutionConcurrency;
  readonly rollback?: PipelineExecutionConcurrency;
  readonly sourceInventoryScan?: number;
}

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
  const groupDepth = operation.target.kind === "group" ? 1 : 0;

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
  const hasGroupRoot = operation.target.kind === "group";

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
          <text fg={colors.foreground}>{targetLabel(operation.target)}</text>
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
    hierarchyItems.length + (operation.target.kind === "group" ? 1 : 0);
  const dialogHeight = Math.max(
    1,
    Math.min(Math.max(11, hierarchyRows + 9), height - 4)
  );
  const hierarchyScrollable = hierarchyRows + 9 > dialogHeight;
  const dialogPadding = compact ? 1 : 2;
  const rollback = operation.action === "rollback";

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
        borderColor={rollback ? colors.danger : colors.warning}
        focusedBorderColor={rollback ? colors.danger : colors.warning}
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
          <DialogTitle
            content={
              rollback ? "Confirm rollback" : "Required dependencies not ready"
            }
          />
          <Badge
            intent={rollback ? "danger" : "warning"}
            label={rollback ? "DESTRUCTIVE" : "ACTION REQUIRED"}
          />
        </box>
        <DialogDescription
          content={
            rollback
              ? `${targetLabel(operation.target)} · Step numbers show rollback execution order.`
              : `${targetLabel(operation.target)} · Some required dependencies have not succeeded.`
          }
          wrapMode="none"
        />
        <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
          <text fg={colors.foreground}>
            {rollback ? "Affected migration hierarchy" : "Run order"}
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
          {rollback ? (
            <Button intent="warning" label="y Rollback" onPress={onConfirm} />
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
            {rollback
              ? "y rollback · n/esc cancel"
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
  const [detailTab, setDetailTab] = useState<MigrationDetailTab>("overview");
  const [messageIndex, setMessageIndex] = useState(0);
  const [busy, setBusy] = useState(
    initialRows === undefined ? "Loading status…" : ""
  );
  const [notice, setNotice] = useState<string | null>(recoveryNotice ?? null);
  const [error, setError] = useState<string | null>(null);
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
    [executionSettings.sourceInventoryScan, runtime]
  );

  const openMessages = useCallback(() => {
    setMessageIndex(0);
    setView("dashboard");
    setDetailTab("messages");
  }, []);

  const openBreakLock = useCallback((rowOverride?: MigrateDashboardRow) => {
    const row = rowOverride ?? dashboardStateRef.current.selectedRows[0];

    if (row?.status?.lock == null) {
      return;
    }

    setError(null);
    setPendingLockRow(row);
    setView("break-lock");
  }, []);

  const startTask = useCallback((task: Promise<unknown>) => {
    task.catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const refreshAfterExecutionFailure = useCallback(
    async (cause: unknown) => {
      const executionError = errorMessage(cause);
      await refresh();

      if (!lifecycle.isExitRequested()) {
        setError(executionError);
      }
    },
    [lifecycle, refresh]
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
        `${actionCopy[operation.action].progress} ${targetLabel(operation.target)}…`
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
    [lifecycle, refreshAfterExecutionFailure, runtime]
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
          onObservationWarning: setNotice,
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

        setNotice(result.message);
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
    [lifecycle, refreshAfterExecutionFailure, runtime]
  );

  const stopRun = useCallback(
    async (runId: MigrationRunId) => {
      setView("dashboard");
      setBusy(`Stopping run ${runId}…`);
      setError(null);

      try {
        const result = await runtime.stopRun(runId);
        setNotice(result.message);
        setBusy("");
      } catch (cause) {
        setError(errorMessage(cause));
        setBusy("");
      }
    },
    [runtime]
  );

  const prepareOperation = useCallback(
    async (
      action: MigrateAction,
      options: MigratePrepareOptions = {},
      targetOverride?: MigrateTarget
    ) => {
      const target = targetOverride ?? dashboardStateRef.current.selectedTarget;

      if (target === undefined || lifecycle.isExitRequested()) {
        return;
      }

      setPendingOperation(null);
      setView("dashboard");
      setBusy(`${actionCopy[action].preparing} ${targetLabel(target)}…`);
      setError(null);

      try {
        const execution = migrationExecutionOptions(executionSettings);
        const operation = await runtime.prepare(target, action, {
          ...options,
          ...(execution === undefined ? {} : { execution }),
        });

        if (lifecycle.isExitRequested()) {
          return;
        }

        if (
          operation.action === "rollback" ||
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
    [executeOperation, executionSettings, lifecycle, runtime]
  );

  const openSelectiveRun = useCallback(
    (targetOverride?: MigrateTarget) => {
      const target = targetOverride ?? dashboardStateRef.current.selectedTarget;

      if (target?.kind !== "migration") {
        return;
      }

      setSelectiveTarget(target);
      setSelectiveDraft("");
      setSelectiveFeedback(undefined);
      setSelectiveHistory([]);
      setSelectiveHistoryIndex(0);
      setSelectiveHistoryLoading(true);
      setSelectiveInputReady(false);
      setError(null);
      setView("selective-run");
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
    [runtime]
  );

  const cancelSelectiveRun = useCallback(() => {
    selectiveHistoryRequestRef.current += 1;
    setSelectiveTarget(null);
    setSelectiveDraft("");
    setSelectiveFeedback(undefined);
    setSelectiveInputReady(false);
    setView("dashboard");
  }, []);

  const runSelectiveEntries = useCallback(() => {
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
      prepareOperation("run", { sourceIdentities: selectiveEntries }, target)
    );
  }, [prepareOperation, selectiveEntries, selectiveTarget, startTask]);

  const submitSelectiveEntry = useCallback(
    async (value: string) => {
      const target = selectiveTarget;
      const sourceIdentity = value.trim();

      if (target === null) {
        return;
      }

      if (sourceIdentity === "") {
        runSelectiveEntries();
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
    [runSelectiveEntries, runtime, selectiveEntries, selectiveTarget]
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
  }, [executionSettingsDrafts]);

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

      if (option.view === "selective-run") {
        openSelectiveRun();
        return;
      }

      if (option.view === "break-lock") {
        openBreakLock();
        return;
      }

      if (option.action !== undefined) {
        startTask(prepareOperation(option.action));
      }
    },
    [
      openBreakLock,
      openExecutionSettings,
      openMessages,
      openSelectiveRun,
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
    if (view !== "selective-run") {
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
  }, [pendingLockRow, refreshDashboard, runtime]);

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
      } else if (operation?.action === "rollback" && key.name === "y") {
        startTask(executeOperation(operation));
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
            operation.target
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
            operation.target
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
  }, [lifecycle]);

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

    let nextIndex: number | undefined;
    if (key.name === "up" || key.name === "k") {
      nextIndex = state.selectedIndex - 1;
    } else if (key.name === "down" || key.name === "j") {
      nextIndex = state.selectedIndex + 1;
    } else if (key.name === "pageup") {
      nextIndex = state.selectedIndex - 10;
    } else if (key.name === "pagedown") {
      nextIndex = state.selectedIndex + 10;
    } else if (key.name === "home") {
      nextIndex = 0;
    } else if (key.name === "end") {
      nextIndex = state.count - 1;
    }

    if (nextIndex === undefined) {
      return false;
    }

    key.preventDefault();
    key.stopPropagation();
    setMessageIndex(
      Math.min(Math.max(0, nextIndex), Math.max(0, state.count - 1))
    );
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
    } else if (
      view === "dashboard" &&
      detailTab === "messages" &&
      handleMessageKey(key)
    ) {
      return;
    } else if (view === "execution-settings") {
      handleExecutionSettingsKey(key);
    } else if (view === "selective-run") {
      handleSelectiveRunKey(key);
    } else if (key.name === "q") {
      startTask(requestExit());
    } else if (view === "dashboard" && detailTab === "overview") {
      handleOverviewKey(key);
    }
  });

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
          <text fg={colors.success}>{notice}</text>
        )}
      </box>
      {view === "confirm" && pendingOperation !== null ? (
        <SafetyDialog
          height={dimensions.height}
          onCancel={cancelConfirmation}
          onConfirm={() => {
            if (pendingOperation.action === "rollback") {
              startTask(executeOperation(pendingOperation));
            }
          }}
          onForce={() => {
            if (pendingOperation.action !== "rollback") {
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
                  pendingOperation.target
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
                  pendingOperation.target
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
      {view === "selective-run" && selectiveTarget !== null ? (
        <SelectiveRunDialog
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
          onDraftChange={setSelectiveDraft}
          onKeyDown={handleSelectiveRunKey}
          onRun={runSelectiveEntries}
          onSubmit={submitSelectiveEntry}
          width={dimensions.width}
        />
      ) : null}
    </box>
  );
};
