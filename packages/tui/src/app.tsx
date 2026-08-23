import { basename } from "node:path";
import { type KeyEvent, RGBA } from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { MigrationTuiExecutionState } from "./execution-controller.ts";
import type {
  MigrationTuiAction,
  MigrationTuiMessage,
  MigrationTuiPreparedOperation,
  MigrationTuiPrepareOptions,
  MigrationTuiRow,
  MigrationTuiRuntime,
  MigrationTuiSourceIdentityHistoryEntry,
  MigrationTuiTarget,
} from "./runtime.ts";
import {
  type MigrationTuiSignalSource,
  makeMigrationTuiShutdownController,
  registerMigrationTuiSignalHandlers,
} from "./shutdown-controller.ts";

type View = "actions" | "confirm" | "dashboard" | "selective-run";

interface ActionOption {
  readonly action?: MigrationTuiAction;
  readonly description: string;
  readonly key: string;
  readonly label: string;
  readonly view?: "messages" | "scan" | "selective-run";
}

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
};

const targetLabel = (target: MigrationTuiTarget): string =>
  target.kind === "group" ? target.groupId : target.definitionId;

const actionOptions = (
  target: MigrationTuiTarget,
  rows: readonly MigrationTuiRow[]
): readonly ActionOption[] => {
  const isGroup = target.kind === "group";
  const noun = isGroup ? "group" : "migration";
  const options: ActionOption[] = [
    {
      action: "run",
      description: isGroup
        ? "Run every migration in this group"
        : "Run this migration",
      key: "r",
      label: isGroup ? "Run group" : "Run",
    },
  ];

  if (!isGroup) {
    options.push({
      description:
        "Run specific source identities, including identities from history",
      key: "e",
      label: "Run selected entries",
      view: "selective-run",
    });
  }

  if (rows.some((row) => (row.status?.durable.failed ?? 0) > 0)) {
    options.push({
      action: "retry-failed",
      description: `Retry only failed items in this ${noun}`,
      key: "f",
      label: "Retry failed",
    });
  }

  options.push(
    {
      action: "rescan",
      description: `Scan this ${noun} from the beginning and skip unchanged items`,
      key: "",
      label: "Rescan source",
    },
    {
      action: "update",
      description: `Scan this ${noun} from the beginning and reprocess migrated items`,
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
      key: "b",
      label: isGroup ? "Rollback group" : "Rollback",
    });
  }

  options.push(
    {
      description: `View ${noun} errors, warnings, and messages`,
      key: "m",
      label: "Messages",
      view: "messages",
    },
    {
      description: "Scan the source and reload status",
      key: "s",
      label: "Scan source status",
      view: "scan",
    }
  );

  return options;
};

const actionProgressLabel = (action: MigrationTuiAction): string => {
  switch (action) {
    case "rescan":
      return "Rescanning";
    case "retry-failed":
      return "Retrying failed items for";
    case "rollback":
      return "Rolling back";
    case "run":
      return "Running";
    case "update":
      return "Updating";
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
};

const actionPreparationLabel = (action: MigrationTuiAction): string => {
  switch (action) {
    case "rescan":
      return "Preparing to rescan";
    case "retry-failed":
      return "Preparing to retry failed items for";
    case "rollback":
      return "Preparing to roll back";
    case "run":
      return "Preparing to run";
    case "update":
      return "Preparing to update";
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
};

const runNeedsDependencyDecision = (
  operation: MigrationTuiPreparedOperation
): boolean =>
  operation.action === "run" &&
  operation.plan.force !== true &&
  operation.dependencyChecks.some((dependency) => !dependency.satisfied);

interface PlanHierarchyItem {
  readonly ancestorsAreLast: readonly boolean[];
  readonly depth: number;
  readonly executionStep?: number;
  readonly id: MigrationTuiRow["entry"]["id"];
  readonly isLast: boolean;
  readonly relation?: "optional" | "required";
  readonly row?: MigrationTuiRow;
}

const planHierarchyItems = (
  operation: MigrationTuiPreparedOperation
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
  const executionPosition = (id: MigrationTuiRow["entry"]["id"]): number =>
    executionSteps.get(id) ?? Number.MAX_SAFE_INTEGER;
  const children = new Map<
    MigrationTuiRow["entry"]["id"],
    Map<MigrationTuiRow["entry"]["id"], "optional" | "required">
  >();
  const addEdge = (
    dependentId: MigrationTuiRow["entry"]["id"],
    dependencyId: MigrationTuiRow["entry"]["id"],
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
  const visited = new Set<MigrationTuiRow["entry"]["id"]>();
  const groupDepth = operation.target.kind === "group" ? 1 : 0;

  const visit = (
    id: MigrationTuiRow["entry"]["id"],
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
  readonly operation: MigrationTuiPreparedOperation;
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
              <text fg={colors.dim}> #{item.executionStep}</text>
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

const executionStateLabel = (state: MigrationTuiExecutionState): string => {
  switch (state.kind) {
    case "cancelling":
      return state.runId === undefined
        ? "Exit requested; waiting for the run to start…"
        : `Cancelling run ${state.runId}; waiting for active work to finish…`;
    case "observing":
      return `Run ${state.runId} is running…`;
    case "running":
      return `Run ${state.runId} is running…`;
    case "starting":
      return `Starting ${state.definitionId}…`;
    default: {
      const unhandled: never = state;
      return unhandled;
    }
  }
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
  readonly operation: MigrationTuiPreparedOperation;
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
              ? `${targetLabel(operation.target)} · Affected migrations will roll back in this order.`
              : `${targetLabel(operation.target)} · Some required dependencies have not succeeded.`
          }
          wrapMode="none"
        />
        <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
          <text fg={colors.foreground}>
            {rollback ? "Rollback order" : "Run order"}
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
              <Button intent="warning" label="f Force run" onPress={onForce} />
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
  runtime,
}: {
  readonly runtime: MigrationTuiRuntime;
}) => {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [rows, setRows] = useState(runtime.rows);
  const [listTab, setListTab] = useState<MigrationListTab>("migrations");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionIndex, setActionIndex] = useState(0);
  const [view, setView] = useState<View>("dashboard");
  const [pendingOperation, setPendingOperation] =
    useState<MigrationTuiPreparedOperation | null>(null);
  const [detailTab, setDetailTab] = useState<MigrationDetailTab>("overview");
  const [messages, setMessages] = useState<readonly MigrationTuiMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [busy, setBusy] = useState("Loading status…");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectiveTarget, setSelectiveTarget] = useState<Extract<
    MigrationTuiTarget,
    { readonly kind: "migration" }
  > | null>(null);
  const [selectiveDraft, setSelectiveDraft] = useState("");
  const [selectiveEntriesByDefinition, setSelectiveEntriesByDefinition] =
    useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const [selectiveHistory, setSelectiveHistory] = useState<
    readonly MigrationTuiSourceIdentityHistoryEntry[]
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
  const selectedRow = rows[selectedIndex] ?? rows[0];
  const selectedGroup = runtime.groups[selectedIndex] ?? runtime.groups[0];
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
  const selectedTarget = useMemo<MigrationTuiTarget | undefined>(() => {
    if (listTab === "groups") {
      return selectedGroup === undefined
        ? undefined
        : { groupId: selectedGroup.id, kind: "group" };
    }

    return selectedRow === undefined
      ? undefined
      : { definitionId: selectedRow.entry.id, kind: "migration" };
  }, [listTab, selectedGroup, selectedRow]);
  const selectiveEntries = useMemo(
    () =>
      selectiveTarget === null
        ? []
        : (selectiveEntriesByDefinition.get(selectiveTarget.definitionId) ??
          []),
    [selectiveEntriesByDefinition, selectiveTarget]
  );
  const dashboardStateRef = useRef({ busy, selectedRows, selectedTarget });
  const executingRef = useRef(false);
  const selectiveHistoryRequestRef = useRef(0);
  dashboardStateRef.current = { busy, selectedRows, selectedTarget };
  const shutdown = useMemo(
    () =>
      makeMigrationTuiShutdownController({
        cancelActiveExecution: runtime.cancelActiveExecution,
        destroy: () => renderer.destroy(),
      }),
    [renderer, runtime]
  );

  const refresh = useCallback(
    async (scanSource = false) => {
      setBusy(scanSource ? "Scanning source…" : "Reloading status…");
      setError(null);

      try {
        const snapshot = await runtime.refresh(scanSource);
        setRows(snapshot.rows);
        setNotice(
          snapshot.scannedSource ? "Source scan complete" : "Status reloaded"
        );
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setBusy("");
      }
    },
    [runtime]
  );

  const openMessages = useCallback(() => {
    setView("dashboard");
    setDetailTab("messages");
  }, []);

  const startTask = useCallback((task: Promise<unknown>) => {
    task.catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  const executeOperation = useCallback(
    async (operation: MigrationTuiPreparedOperation) => {
      if (executingRef.current) {
        return;
      }

      executingRef.current = true;
      setView("dashboard");
      setPendingOperation(null);
      setBusy(
        `${actionProgressLabel(operation.action)} ${targetLabel(operation.target)}…`
      );
      setError(null);

      try {
        const result = await runtime.execute(operation, {
          onStateChange: (state) => setBusy(executionStateLabel(state)),
        });

        if (shutdown.isExitRequested()) {
          return;
        }

        setNotice(result);
        await refresh(false);
      } catch (cause) {
        if (shutdown.isExitRequested()) {
          return;
        }

        setError(errorMessage(cause));
        setBusy("");
      } finally {
        executingRef.current = false;
        shutdown.executionSettled();
      }
    },
    [refresh, runtime, shutdown]
  );

  const prepareOperation = useCallback(
    async (
      action: MigrationTuiAction,
      options: MigrationTuiPrepareOptions = {},
      targetOverride?: MigrationTuiTarget
    ) => {
      const target = targetOverride ?? dashboardStateRef.current.selectedTarget;

      if (target === undefined || shutdown.isExitRequested()) {
        return;
      }

      setPendingOperation(null);
      setView("dashboard");
      setBusy(`${actionPreparationLabel(action)} ${targetLabel(target)}…`);
      setError(null);

      try {
        const operation = await runtime.prepare(target, action, options);

        if (shutdown.isExitRequested()) {
          return;
        }

        if (
          operation.action === "rollback" ||
          runNeedsDependencyDecision(operation)
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
    [executeOperation, runtime, shutdown]
  );

  const openSelectiveRun = useCallback(
    (targetOverride?: MigrationTuiTarget) => {
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
    (value: string) => {
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
        const normalized = runtime.normalizeSourceIdentity(
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

  const chooseOption = useCallback(
    (option: ActionOption | undefined) => {
      if (option === undefined) {
        return;
      }

      if (option.view === "messages") {
        openMessages();
        return;
      }

      if (option.view === "scan") {
        setView("dashboard");
        startTask(refresh(true));
        return;
      }

      if (option.view === "selective-run") {
        openSelectiveRun();
        return;
      }

      if (option.action !== undefined) {
        startTask(prepareOperation(option.action));
      }
    },
    [openMessages, openSelectiveRun, prepareOperation, refresh, startTask]
  );

  const selectedActions = useMemo(
    () =>
      selectedTarget === undefined
        ? []
        : actionOptions(selectedTarget, selectedRows),
    [selectedRows, selectedTarget]
  );

  useEffect(() => {
    startTask(refresh(false));
  }, [refresh, startTask]);

  useEffect(() => {
    if (view !== "selective-run") {
      return;
    }

    const timer = setTimeout(() => setSelectiveInputReady(true), 100);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(() => {
    if (selectedTarget === undefined) {
      setMessages([]);
      setMessagesLoading(false);
      return;
    }

    let active = true;
    setMessages([]);
    setMessagesLoading(true);

    runtime
      .listMessages(selectedTarget)
      .then((nextMessages) => {
        if (active) {
          setMessages(nextMessages);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (active) {
          setMessagesLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [runtime, selectedTarget]);

  const cancelConfirmation = useCallback(() => {
    setPendingOperation(null);
    setView("dashboard");
  }, []);

  const handleConfirmationKey = useCallback(
    (key: KeyEvent) => {
      const operation = pendingOperation;

      key.preventDefault();
      key.stopPropagation();

      if (key.name === "n" || key.name === "escape") {
        cancelConfirmation();
      } else if (operation?.action === "rollback" && key.name === "y") {
        startTask(executeOperation(operation));
      } else if (operation?.action === "run" && key.name === "i") {
        startTask(
          prepareOperation(
            "run",
            {
              ...(operation.sourceIdentities === undefined
                ? {}
                : { sourceIdentities: operation.sourceIdentities }),
              withDependencies: true,
            },
            operation.target
          )
        );
      } else if (operation?.action === "run" && key.name === "f") {
        startTask(
          prepareOperation(
            "run",
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
        const option = selectedActions.find(
          (candidate) => candidate.key === key.name
        );

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
        startTask(refresh(false));
        return;
      }

      switch (key.name) {
        case "r":
          startTask(prepareOperation("run"));
          break;
        case "e":
          if (target.kind === "migration") {
            openSelectiveRun(target);
          }
          break;
        case "f":
          if (
            state.selectedRows.some(
              (row) => (row.status?.durable.failed ?? 0) > 0
            )
          ) {
            startTask(prepareOperation("retry-failed"));
          }
          break;
        case "b":
          if (
            state.selectedRows.length > 0 &&
            state.selectedRows.every((row) => row.entry.hasRollback)
          ) {
            startTask(prepareOperation("rollback"));
          }
          break;
        case "m":
          openMessages();
          break;
        case "s":
          startTask(refresh(true));
          break;
        default:
          break;
      }
    },
    [openMessages, openSelectiveRun, prepareOperation, refresh, startTask]
  );

  const requestExit = useCallback(async () => {
    try {
      const cancellation = await shutdown.requestExit();

      if (cancellation.kind !== "idle") {
        setBusy(cancellation.message);
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy("");
    }
  }, [shutdown]);

  useEffect(
    () =>
      registerMigrationTuiSignalHandlers({
        onSignal: (_signal, exitCode) => {
          process.exitCode = exitCode;
          startTask(requestExit());
        },
        source: process as unknown as MigrationTuiSignalSource,
      }),
    [requestExit, startTask]
  );

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
      if (dashboardStateRef.current.busy !== "") {
        return;
      }

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
      rows.length,
      runtime.groups.length,
    ]
  );

  useKeyboard((key) => {
    if (
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
      key.name === "escape"
    ) {
      setDetailTab("overview");
    } else if (key.ctrl && key.name === "c") {
      process.exitCode = 130;
      startTask(requestExit());
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
          Actions ·{" "}
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
        <text fg={colors.dim}>{basename(runtime.configPath)}</text>
      </box>
      <MigrationDashboard
        activeTab={detailTab}
        busy={busy}
        groups={runtime.groups}
        listTab={listTab}
        messages={messages}
        messagesLoading={messagesLoading}
        onAction={(action) => startTask(prepareOperation(action))}
        onBackToOverview={() => setDetailTab("overview")}
        onListTabChange={changeListTab}
        onOpenActions={() => {
          setActionIndex(0);
          setView("actions");
        }}
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
        terminalWidth={dimensions.width}
      />
      <box style={{ flexShrink: 0, height: 1 }}>
        {busy === "" ? null : <text fg={colors.info}>{busy}</text>}
        {busy !== "" || error === null ? null : (
          <text fg={colors.danger}>{error}</text>
        )}
        {busy !== "" || error !== null || notice === null ? null : (
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
            if (pendingOperation.action === "run") {
              startTask(
                prepareOperation(
                  "run",
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
            if (pendingOperation.action === "run") {
              startTask(
                prepareOperation(
                  "run",
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
