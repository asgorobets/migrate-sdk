import { type KeyEvent, RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { RadioGroup } from "@tuiparts/react/radio-group";
import type {
  MigrationDefinitionId,
  MigrationExecutionOptions,
  MigrationMessage,
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
import {
  SelectiveRunDialog,
  type SelectiveRunMode,
} from "./components/selective-run-dialog.tsx";
import {
  SessionActivityView,
  type SessionActivityViewMode,
} from "./components/session-activity-view.tsx";
import { StoreSchemaSetup } from "./components/store-schema-setup.tsx";
import { Badge } from "./components/ui/badge.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./components/ui/dialog.tsx";
import { Radio } from "./components/ui/radio.tsx";
import type { MigrationTuiExecutionResult } from "./execution.ts";
import { nextListSelection } from "./list-navigation.ts";
import { rollbackConfirmation } from "./rollback-confirmation.ts";
import { prepareRollbackScope, type RollbackScope } from "./rollback-scope.ts";
import type {
  MigrationTuiDashboardState,
  MigrationTuiRuntime,
} from "./runtime.ts";
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

interface ExpandedMessage {
  readonly index: number;
  readonly message: MigrationMessage;
  readonly showDefinitionId: boolean;
  readonly total: number;
}

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
    dependencyDescription: "Rescan migrations with dependencies",
    preparing: "Preparing to rescan",
    progress: "Rescanning",
  },
  "retry-failed": {
    button: "retry",
    dependencyDescription: "Retry failed items with dependencies",
    preparing: "Preparing to retry failed items for",
    progress: "Retrying failed items for",
  },
  "retry-skipped": {
    button: "retry",
    dependencyDescription: "Retry skipped items with dependencies",
    preparing: "Preparing to retry skipped items for",
    progress: "Retrying skipped items for",
  },
  rollback: {
    button: "rollback",
    dependencyDescription: "Rollback migrations with dependencies",
    preparing: "Preparing rollback for",
    progress: "Rollback in progress for",
  },
  run: {
    button: "run",
    dependencyDescription: "Run migrations with dependencies",
    preparing: "Preparing to run",
    progress: "Running",
  },
  update: {
    button: "update",
    dependencyDescription: "Update migrations with dependencies",
    preparing: "Preparing to update",
    progress: "Updating",
  },
} as const satisfies Record<
  MigrateAction,
  {
    readonly button: string;
    readonly dependencyDescription: string;
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

const assertRequestedLimit = (
  operation: MigratePreparedOperation,
  limit: number | undefined
): void => {
  if (
    limit !== undefined &&
    (operation.plan.limit !== limit ||
      operation.request.options.limit !== limit)
  ) {
    throw new Error(
      "Server did not preserve the requested item limit. Upgrade the server before running limited migrations."
    );
  }
};

const operationRollsBackOrphans = (
  operation: MigratePreparedOperation
): boolean =>
  operation.action === "run" && operation.plan.rollbackOrphans === true;

const preparedOperationCopy = (operation: MigratePreparedOperation) =>
  operationRollsBackOrphans(operation)
    ? {
        button: "rollback orphans",
        preparing: "Preparing orphan rollback for",
        progress: "Orphan rollback in progress for",
      }
    : actionCopy[operation.action];

const executionPlanItems = (operation: MigratePreparedOperation) => {
  const rows = new Map(operation.planRows.map((row) => [row.entry.id, row]));
  return operation.plan.executionDefinitionIds.map((id, index) => ({
    id,
    executionStep: index + 1,
    row: rows.get(id),
  }));
};

const ExecutionPlan = ({
  operation,
}: {
  readonly operation: MigratePreparedOperation;
}) => {
  const items = executionPlanItems(operation);
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

        return (
          <box
            key={item.id}
            style={{ flexDirection: "row", flexShrink: 0, height: 1 }}
          >
            <text fg={colors.dim}>{item.executionStep}. </text>
            <text fg={migrationStatusColor(label)}>
              {migrationStatusIcon(label)}{" "}
            </text>
            <text fg={colors.foreground}>{item.id}</text>
            <box style={{ flexGrow: 1 }} />
            <text fg={migrationStatusColor(label)}>{label.toUpperCase()}</text>
          </box>
        );
      })}
    </box>
  );
};

const operationConfirmationCopy = (operation: MigratePreparedOperation) => {
  const rollback = operation.action === "rollback";
  const rollbackOrphans = operationRollsBackOrphans(operation);
  const dependencyDecision = operationNeedsDependencyDecision(operation);
  const forcedRollback = rollback && operation.plan.force === true;
  let title = "Dependencies incomplete";
  let description: string = rollbackOrphans
    ? "Rollback orphaned items with dependencies"
    : actionCopy[operation.action].dependencyDescription;
  let badgeLabel = "ACTION REQUIRED";
  let planLabel = rollbackOrphans ? "Migration plan" : "Run order";
  let confirmationButtonLabel = "";
  let destructiveShortcut = "";

  const rollbackCopy = rollback ? rollbackConfirmation(operation) : undefined;
  if (rollback) {
    title = "Confirm rollback";
    planLabel = "Rollback order";
    badgeLabel = forcedRollback ? "UNSAFE" : "DESTRUCTIVE";
    confirmationButtonLabel =
      rollbackCopy?.buttonLabel ?? "y Rollback selected";
    destructiveShortcut = "i include · s selected only · y confirm";
  } else if (rollbackOrphans && !dependencyDecision) {
    title = "Confirm orphan rollback";
    description = "Rollback destination items missing from source";
    badgeLabel = "DESTRUCTIVE";
    confirmationButtonLabel = "y Rollback orphans";
    destructiveShortcut = "y rollback orphans";
  }

  const paragraphs = rollbackCopy?.paragraphs ?? [description];
  const forceWarning = dependencyDecision
    ? "Force skips dependencies; some items may fail."
    : null;

  return {
    title,
    badgeLabel,
    planLabel,
    confirmationButtonLabel,
    destructiveShortcut,
    paragraphs,
    forceWarning,
  };
};

const SafetyDialog = ({
  height,
  onCancel,
  onForce,
  onConfirm,
  onIncludeDependencies,
  onKeyDown,
  operation,
  preview,
  rollbackPlanError,
  rollbackPlanUpdating,
  onRollbackScopeChange,
  width,
}: {
  readonly rollbackPlanError: string | null;
  readonly rollbackPlanUpdating: boolean;
  readonly onRollbackScopeChange: (scope: RollbackScope) => void;
  readonly height: number;
  readonly onCancel: () => void;
  readonly onForce: () => void;
  readonly onConfirm: () => void;
  readonly onIncludeDependencies: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly operation: MigratePreparedOperation;
  readonly preview: MigratePreparedOperation | null;
  readonly width: number;
}) => {
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(76, width - (compact ? 8 : 4)));
  const hierarchyItems = executionPlanItems(preview ?? operation);
  const hierarchyRows =
    hierarchyItems.length + (operation.selection.kind === "group" ? 1 : 0);
  const rollback = operation.action === "rollback";
  const rollbackExtraRows = operation.plan.force === true ? 13 : 12;
  const limited = operation.plan.limit !== undefined;
  const dialogHeight = Math.max(
    1,
    Math.min(
      Math.max(
        rollback ? 14 : 13,
        hierarchyRows + (rollback ? rollbackExtraRows : 10) + (limited ? 3 : 0)
      ),
      height - 4
    )
  );
  const dialogPadding = compact ? 1 : 2;
  const rollbackOrphans = operationRollsBackOrphans(operation);
  const dependencyDecision = operationNeedsDependencyDecision(operation);
  const destructive = rollback || (rollbackOrphans && !dependencyDecision);
  const {
    title,
    badgeLabel,
    planLabel,
    confirmationButtonLabel,
    destructiveShortcut,
    paragraphs,
    forceWarning,
  } = operationConfirmationCopy(operation);
  const rollbackScopeHint =
    rollbackPlanError ?? (rollbackPlanUpdating ? "Updating plan…" : null);

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
        <scrollbox
          focusable
          focused
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
          <box
            style={{ flexDirection: "column", flexShrink: 0, width: "100%" }}
          >
            {paragraphs.map((paragraph) => (
              <DialogDescription
                content={paragraph}
                flexShrink={0}
                key={paragraph}
                wrapMode="word"
              />
            ))}
            {forceWarning !== null && (
              <DialogDescription
                content={forceWarning}
                flexShrink={0}
                wrapMode="word"
              />
            )}
            <text fg={colors.foreground} marginTop={1}>
              {planLabel}
            </text>
          </box>
          <ExecutionPlan operation={preview ?? operation} />
        </scrollbox>
        {limited && (
          <text fg={colors.info} flexShrink={0} marginTop={1} wrapMode="word">
            Up to {operation.plan.limit}{" "}
            {operation.plan.limit === 1 ? "item" : "items"} per migration,
            including dependencies.
          </text>
        )}
        {rollback && (
          <box flexDirection="column" flexShrink={0} marginTop={1}>
            <RadioGroup
              disabled={rollbackPlanUpdating}
              flexDirection="column"
              flexShrink={0}
              onValueChange={(scope) => {
                if (
                  scope === "include-dependencies" ||
                  scope === "selected-only"
                ) {
                  onRollbackScopeChange(scope);
                }
              }}
              value={
                operation.plan.withDependencies
                  ? "include-dependencies"
                  : "selected-only"
              }
            >
              <Radio
                accentColor={colors.info}
                disabled={operation.sourceIdentities !== undefined}
                label="i Include dependencies (recommended)"
                value="include-dependencies"
              />
              <Radio
                accentColor={colors.info}
                label="s Selected only"
                value="selected-only"
              />
            </RadioGroup>
            {rollbackScopeHint !== null && (
              <text
                fg={rollbackPlanError === null ? colors.dim : colors.danger}
                wrapMode="word"
              >
                {rollbackScopeHint}
              </text>
            )}
          </box>
        )}
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
          {destructive || (limited && !dependencyDecision) ? (
            <Button
              disabled={rollbackPlanUpdating || rollbackPlanError !== null}
              intent={destructive ? "warning" : "primary"}
              label={confirmationButtonLabel}
              onPress={onConfirm}
            />
          ) : (
            <>
              <Button
                label="i Include dependencies"
                onPress={onIncludeDependencies}
              />
              <Button
                intent="warning"
                label={`f Force ${preparedOperationCopy(operation).button}`}
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
            {"↑↓ scroll · "}
            {dependencyDecision
              ? "i include · f force · n/esc cancel"
              : `${limited ? "y run" : destructiveShortcut} · n/esc cancel`}
          </text>
        </box>
      </DialogContent>
    </Dialog>
  );
};

interface MigrationTuiAppProps {
  readonly initialDashboardState?: MigrationTuiDashboardState;
  readonly initialRows?: readonly MigrateDashboardRow[];
  readonly lifecycle: MigrationTuiShutdownController;
  readonly loadStatusOnStartup?: boolean;
  readonly onDashboardStateChange?: (state: MigrationTuiDashboardState) => void;
  readonly recoveryNotice?: string;
  readonly runtime: MigrationTuiRuntime;
}

const statusActivityMessage = (
  rows: readonly MigrateDashboardRow[],
  loading: boolean
): string => {
  if (loading) {
    return "Loading status…";
  }
  return rows.some((row) => row.status === undefined)
    ? "Status not loaded · R to load"
    : "";
};

export const MigrationTuiApp = (props: MigrationTuiAppProps) => {
  const [readyRows, setReadyRows] = useState<
    readonly MigrateDashboardRow[] | null
  >(() =>
    props.runtime.storeSchema === null ||
    props.runtime.storeSchema.status === "current"
      ? (props.initialRows ?? props.runtime.rows)
      : null
  );
  if (readyRows === null) {
    return (
      <StoreSchemaSetup
        onExit={props.lifecycle.requestExit}
        onReady={setReadyRows}
        runtime={props.runtime}
      />
    );
  }
  return <MigrationTuiDashboardApp {...props} initialRows={readyRows} />;
};

const MigrationTuiDashboardApp = ({
  initialDashboardState,
  initialRows,
  loadStatusOnStartup = true,
  lifecycle,
  onDashboardStateChange,
  recoveryNotice,
  runtime,
}: MigrationTuiAppProps) => {
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
  const [dependencyPreview, setDependencyPreview] =
    useState<MigratePreparedOperation | null>(null);
  const [rollbackPlanUpdating, setRollbackPlanUpdating] = useState(false);
  const [rollbackPlanError, setRollbackPlanError] = useState<string | null>(
    null
  );
  const rollbackPlanUpdateRef = useRef<symbol | null>(null);
  const [pendingLockRow, setPendingLockRow] =
    useState<MigrateDashboardRow | null>(null);
  const [selectiveAction, setSelectiveAction] = useState<"rollback" | "run">(
    "run"
  );
  const [detailTab, setDetailTab] = useState<MigrationDetailTab>("overview");
  const [messageIndex, setMessageIndex] = useState(0);
  const [expandedMessage, setExpandedMessage] =
    useState<ExpandedMessage | null>(null);
  const [busy, setBusyState] = useState("");
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
  const [selectiveTarget, setSelectiveTarget] = useState<MigrateTarget | null>(
    null
  );
  const [selectiveRunMode, setSelectiveRunMode] =
    useState<SelectiveRunMode>("next-items");
  let selectiveMode = selectiveRunMode;
  if (selectiveAction === "rollback") {
    selectiveMode = "source-ids";
  } else if (selectiveTarget?.kind === "group") {
    selectiveMode = "next-items";
  }
  const [selectiveLimit, setSelectiveLimit] = useState<number | null>(1);
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
  const {
    activeRuns,
    durableRows,
    refresh,
    startObservation,
    statusError,
    statusLoading,
  } = useDashboardObservation({
    clearSourceScanStatuses,
    initialDashboardState,
    initialRows,
    loadStatusOnStartup,
    onDashboardStateChange,
    recordActivity: appendActivity,
    recoveryNotice,
    runtime,
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
  const {
    load: loadMessages,
    messages,
    status: messagesStatus,
  } = useMigrationMessages({
    rows: durableRows,
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
    async (...args: Parameters<typeof refresh>) => {
      clearSourceItemTotalCache();
      await refresh(...args);
    },
    [clearSourceItemTotalCache, refresh]
  );
  const sourceItemTotalsError =
    sourceItemTotalsFailure === null
      ? null
      : `Unable to count source items: ${errorMessage(sourceItemTotalsFailure.cause)}`;
  const displayedError = error ?? statusError ?? sourceItemTotalsError;
  const selectedActiveRun = useMemo(() => {
    const matching = activeRuns.filter((run) =>
      selectedRows.some((row) => row.status?.lock?.ownerRunId === run.runId)
    );

    return matching.length === 1 ? matching[0] : undefined;
  }, [activeRuns, selectedRows]);
  const selectiveEntries = useMemo(
    () =>
      selectiveTarget?.kind === "migration"
        ? (selectiveEntriesByDefinition.get(selectiveTarget.definitionId) ?? [])
        : [],
    [selectiveEntriesByDefinition, selectiveTarget]
  );
  const effectiveBusy = busy;
  const displayedActivity =
    effectiveBusy || statusActivityMessage(durableRows, statusLoading);
  const dashboardStateRef = useRef({
    busy: effectiveBusy,
    selectedRows,
    selectedTarget,
  });
  const messageStateRef = useRef({
    count: messages.length,
    selectedIndex: messageIndex,
    message: messages[messageIndex],
    showDefinitionId: selectedTarget?.kind === "group",
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
    message: messages[messageIndex],
    showDefinitionId: selectedTarget?.kind === "group",
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
        if (snapshot.activeRuns.length > 0) {
          startObservation(snapshot);
        }
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
      startObservation,
    ]
  );

  const openMessages = useCallback(() => {
    setError(null);
    loadMessages();
    setMessageIndex(0);
    setView("dashboard");
    setDetailTab("messages");
  }, [loadMessages, setError]);

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
        startObservation();
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
        setBusy("");
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
      startObservation,
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
      setDependencyPreview(null);
      setView("dashboard");
      setBusy(
        `${options.rollbackOrphans === true ? "Preparing orphan rollback for" : actionCopy[action].preparing} ${selectionLabel(selection)}…`
      );
      setError(null);

      try {
        const execution = migrationExecutionOptions(executionSettings);
        const prepareOptions = {
          ...options,
          ...(execution === undefined ? {} : { execution }),
        };
        const operation =
          action === "rollback"
            ? await prepareRollbackScope(
                runtime,
                selection,
                options.sourceIdentities !== undefined ||
                  options.withDependencies === false
                  ? "selected-only"
                  : "include-dependencies",
                prepareOptions
              )
            : await runtime.prepare(selection, action, prepareOptions);
        assertRequestedLimit(operation, options.limit);

        if (lifecycle.isExitRequested()) {
          return;
        }

        if (
          operation.action === "rollback" ||
          operationRollsBackOrphans(operation) ||
          operationNeedsDependencyDecision(operation)
        ) {
          if (operationNeedsDependencyDecision(operation)) {
            const preview = await runtime.prepare(selection, action, {
              ...options,
              ...(execution === undefined ? {} : { execution }),
              withDependencies: true,
            });
            assertRequestedLimit(preview, options.limit);
            if (lifecycle.isExitRequested()) {
              return;
            }
            setDependencyPreview(preview);
          }
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

      if (
        target === undefined ||
        (action === "rollback" && target.kind !== "migration")
      ) {
        return;
      }

      setSelectiveLimit(1);
      setSelectiveAction(action);
      setSelectiveTarget(target);
      setSelectiveDraft("");
      setSelectiveFeedback(undefined);
      setSelectiveHistory([]);
      setSelectiveHistoryIndex(0);
      setSelectiveHistoryLoading(false);
      setSelectiveInputReady(false);
      setError(null);
      setView(action === "rollback" ? "selective-rollback" : "selective-run");
    },
    [setError]
  );

  useEffect(() => {
    if (
      (view !== "selective-run" && view !== "selective-rollback") ||
      selectiveMode !== "source-ids" ||
      selectiveTarget?.kind !== "migration"
    ) {
      return;
    }
    const requestId = ++selectiveHistoryRequestRef.current;
    setSelectiveHistoryLoading(true);
    setSelectiveHistory([]);
    runtime
      .listSourceIdentityHistory(selectiveTarget.definitionId)
      .then((history) => {
        if (selectiveHistoryRequestRef.current === requestId) {
          setSelectiveHistory(history);
          setSelectiveHistoryIndex(0);
        }
      })
      .catch((cause: unknown) => {
        if (selectiveHistoryRequestRef.current === requestId) {
          setSelectiveFeedback({ message: errorMessage(cause), tone: "error" });
        }
      })
      .finally(() => {
        if (selectiveHistoryRequestRef.current === requestId) {
          setSelectiveHistoryLoading(false);
        }
      });
    return () => {
      selectiveHistoryRequestRef.current += 1;
    };
  }, [runtime, selectiveMode, selectiveTarget, view]);

  const changeSelectiveMode = useCallback(
    (mode: SelectiveRunMode) => {
      if (selectiveAction !== "run" || selectiveTarget?.kind !== "migration") {
        return;
      }
      setSelectiveRunMode(mode);
      setSelectiveFeedback(undefined);
    },
    [selectiveAction, selectiveTarget]
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

    if (selectiveMode === "next-items") {
      if (
        selectiveLimit === null ||
        !Number.isSafeInteger(selectiveLimit) ||
        selectiveLimit <= 0
      ) {
        setSelectiveFeedback({
          message: "Enter a positive whole number.",
          tone: "error",
        });
        return;
      }
      startTask(
        prepareOperation(
          "run",
          { limit: selectiveLimit },
          selectionFromTarget(target)
        )
      );
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
    selectiveMode,
    selectiveLimit,
    selectiveTarget,
    startTask,
  ]);

  const submitSelectiveEntry = useCallback(
    async (value: string) => {
      const target = selectiveTarget;
      const sourceIdentity = value.trim();

      if (target?.kind !== "migration") {
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

    if (target?.kind !== "migration" || historyEntry === undefined) {
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
      } else if (selectiveMode === "next-items") {
        return;
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

        if (
          selectiveTarget?.kind === "migration" &&
          selectiveEntries.length > 0
        ) {
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
      selectiveMode,
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

  const changeRollbackScope = useCallback(
    async (scope: RollbackScope) => {
      const operation = pendingOperation;
      if (
        operation?.action !== "rollback" ||
        rollbackPlanUpdateRef.current !== null ||
        lifecycle.isExitRequested()
      ) {
        return;
      }
      const token = Symbol("RollbackPlanUpdate");
      rollbackPlanUpdateRef.current = token;
      setRollbackPlanUpdating(true);
      setRollbackPlanError(null);
      try {
        const updated = await prepareRollbackScope(
          runtime,
          operation.selection,
          scope,
          operation.request.options
        );
        if (
          rollbackPlanUpdateRef.current !== token ||
          lifecycle.isExitRequested()
        ) {
          return;
        }
        setPendingOperation(updated);
        setDependencyPreview(null);
      } catch (cause) {
        if (rollbackPlanUpdateRef.current === token) {
          setRollbackPlanError(errorMessage(cause));
        }
      } finally {
        if (rollbackPlanUpdateRef.current === token) {
          rollbackPlanUpdateRef.current = null;
          setRollbackPlanUpdating(false);
        }
      }
    },
    [pendingOperation, runtime, lifecycle]
  );

  const cancelConfirmation = useCallback(() => {
    rollbackPlanUpdateRef.current = null;
    setRollbackPlanUpdating(false);
    setRollbackPlanError(null);
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
    } finally {
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

  const chooseDependencies = useCallback(
    (withDependencies: boolean) => {
      const operation = pendingOperation;
      if (operation === null || !operationNeedsDependencyDecision(operation)) {
        return;
      }
      startTask(
        prepareOperation(
          operation.action,
          {
            ...operation.request.options,
            force: !withDependencies,
            withDependencies,
          },
          operation.selection
        )
      );
    },
    [pendingOperation, prepareOperation, startTask]
  );

  const handleConfirmationKey = useCallback(
    (key: KeyEvent) => {
      const operation = pendingOperation;

      key.preventDefault();
      key.stopPropagation();

      if (key.name === "n" || key.name === "escape") {
        cancelConfirmation();
      } else if (operation?.action === "rollback") {
        if (rollbackPlanUpdateRef.current !== null) {
          return;
        }
        if (key.name === "i" && operation.sourceIdentities === undefined) {
          startTask(changeRollbackScope("include-dependencies"));
        } else if (key.name === "s") {
          startTask(changeRollbackScope("selected-only"));
        } else if (key.name === "y" && rollbackPlanError === null) {
          startTask(executeOperation(operation));
        }
      } else if (
        operation !== null &&
        operationRollsBackOrphans(operation) &&
        !operationNeedsDependencyDecision(operation) &&
        key.name === "y"
      ) {
        startTask(executeOperation(operation));
      } else if (key.name === "i") {
        chooseDependencies(true);
      } else if (key.name === "f") {
        chooseDependencies(false);
      }
    },
    [
      cancelConfirmation,
      changeRollbackScope,
      chooseDependencies,
      rollbackPlanError,
      executeOperation,
      pendingOperation,
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
        startTask(refreshDashboard(undefined, { coalesce: true }));
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
        key.preventDefault();
        key.stopPropagation();
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

  const handleMessageKey = useCallback(
    (key: KeyEvent): boolean => {
      if (key.name === "m") {
        key.preventDefault();
        key.stopPropagation();
        openMessages();
        return true;
      }
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        setDetailTab("overview");
        return true;
      }

      const state = messageStateRef.current;
      if (
        (key.name === "return" || key.name === "linefeed") &&
        state.message !== undefined
      ) {
        key.preventDefault();
        key.stopPropagation();
        setExpandedMessage({
          message: state.message,
          index: state.selectedIndex,
          total: state.count,
          showDefinitionId: state.showDefinitionId,
        });
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
    },
    [openMessages]
  );

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
        (key.name === "s" && pendingOperation?.action === "rollback") ||
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
      // The dialog routes keys using its focused control.
      return;
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
        messagesStatus={messagesStatus}
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
        onTabChange={(tab) => {
          if (tab === "messages") {
            openMessages();
          } else {
            setDetailTab(tab);
          }
        }}
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
            displayedActivity !== "" &&
            (displayedError !== null || notice !== null)
              ? 2
              : 1,
        }}
      >
        {displayedActivity === "" ? null : (
          <text fg={colors.info}>{displayedActivity}</text>
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
              rollbackPlanUpdateRef.current !== null ||
              rollbackPlanError !== null
            ) {
              return;
            }
            if (
              pendingOperation.action === "rollback" ||
              (operationRollsBackOrphans(pendingOperation) &&
                !operationNeedsDependencyDecision(pendingOperation))
            ) {
              startTask(executeOperation(pendingOperation));
            }
          }}
          onForce={() => chooseDependencies(false)}
          onIncludeDependencies={() => chooseDependencies(true)}
          onKeyDown={handleConfirmationKey}
          onRollbackScopeChange={(scope) =>
            startTask(changeRollbackScope(scope))
          }
          operation={pendingOperation}
          preview={dependencyPreview}
          rollbackPlanError={rollbackPlanError}
          rollbackPlanUpdating={rollbackPlanUpdating}
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
      {view === "message-detail" && expandedMessage !== null ? (
        <MessageDetailDialog
          height={dimensions.height}
          index={expandedMessage.index}
          message={expandedMessage.message}
          onClose={() => {
            setExpandedMessage(null);
            setView("dashboard");
          }}
          showDefinitionId={expandedMessage.showDefinitionId}
          total={expandedMessage.total}
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
          draft={selectiveDraft}
          entries={selectiveEntries}
          limit={selectiveLimit}
          mode={selectiveMode}
          onLimitChange={(value) => {
            setSelectiveLimit(value);
            setSelectiveFeedback(undefined);
          }}
          onModeChange={changeSelectiveMode}
          target={selectiveTarget}
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
