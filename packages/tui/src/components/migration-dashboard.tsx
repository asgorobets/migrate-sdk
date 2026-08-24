import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type {
  MigrationDefinitionRegistryGroup,
  MigrationDefinitionSourceStatus,
  MigrationStatusWarning,
} from "migrate-sdk";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { MigrationTuiMessage, MigrationTuiRow } from "../runtime.ts";
import {
  type MigrationTuiAvailableAction,
  migrationTuiPrimaryActions,
  migrationTuiUtilityActions,
} from "./migration-actions.ts";
import {
  migrationMessageKindLabel,
  migrationMessageMarker,
} from "./migration-message.ts";
import { MigrationMessages } from "./migration-messages.tsx";
import { Badge, type BadgeIntent } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";

export const migrationColors = {
  background: "#0d1117",
  border: "#30363d",
  danger: "#ff7b72",
  dim: "#8b949e",
  foreground: "#e6edf3",
  info: "#58a6ff",
  selected: "#1f6feb",
  surface: "#161b22",
  success: "#3fb950",
  warning: "#d29922",
} as const;

export type MigrationDetailTab = "messages" | "overview";
export type MigrationListTab = "groups" | "migrations";

interface DurableCounts {
  readonly failed: number;
  readonly migrated: number;
  readonly needsUpdate: number;
  readonly skipped: number;
}

interface SourceInventory {
  readonly counts: MigrationDefinitionSourceStatus;
  readonly warnings: readonly MigrationStatusWarning[];
}

const countLabel = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

const statusLabel = (row: MigrationTuiRow): string => {
  const status = row.status;

  if (status === undefined) {
    return "loading";
  }
  if (status.lock !== null) {
    return "running";
  }
  if (status.durable.failed > 0 || status.lastRun?.status === "failed") {
    return "failed";
  }
  if (status.durable.needsUpdate > 0) {
    return "needs update";
  }
  if (status.lastRun === null) {
    return "not run";
  }

  return status.lastRun.status;
};

const statusColor = (label: string): string => {
  switch (label) {
    case "error":
    case "failed":
      return migrationColors.danger;
    case "needs update":
    case "warning":
      return migrationColors.warning;
    case "queued":
    case "running":
      return migrationColors.info;
    case "succeeded":
      return migrationColors.success;
    default:
      return migrationColors.dim;
  }
};

const statusIcon = (label: string): string => {
  switch (label) {
    case "failed":
      return "✕";
    case "needs update":
      return "!";
    case "running":
      return "◉";
    case "succeeded":
      return "✓";
    case "loading":
      return "◌";
    case "partial":
      return "◐";
    default:
      return "○";
  }
};

export const migrationStatusColor = statusColor;
export const migrationStatusIcon = statusIcon;
export const migrationStatusLabel = statusLabel;

const statusBadgeIntent = (label: string): BadgeIntent => {
  switch (label) {
    case "failed":
      return "danger";
    case "needs update":
      return "warning";
    case "succeeded":
      return "success";
    default:
      return "neutral";
  }
};

const durableCounts = (row: MigrationTuiRow): DurableCounts => {
  const durable = row.status?.durable;

  return {
    failed: durable?.failed ?? 0,
    migrated: durable?.migrated ?? 0,
    needsUpdate: durable?.needsUpdate ?? 0,
    skipped: durable?.skipped ?? 0,
  };
};

const aggregateCounts = (rows: readonly MigrationTuiRow[]): DurableCounts =>
  rows.reduce(
    (total, row) => {
      const counts = durableCounts(row);

      return {
        failed: total.failed + counts.failed,
        migrated: total.migrated + counts.migrated,
        needsUpdate: total.needsUpdate + counts.needsUpdate,
        skipped: total.skipped + counts.skipped,
      };
    },
    { failed: 0, migrated: 0, needsUpdate: 0, skipped: 0 }
  );

const sourceInventory = (
  rows: readonly MigrationTuiRow[]
): SourceInventory | undefined => {
  const scannedRows = rows.filter((row) => row.status?.source !== undefined);

  if (scannedRows.length === 0) {
    return;
  }

  return {
    counts: scannedRows.reduce<MigrationDefinitionSourceStatus>(
      (total, row) => {
        const source = row.status?.source;

        if (source === undefined) {
          return total;
        }

        return {
          duplicate: total.duplicate + source.duplicate,
          invalid: total.invalid + source.invalid,
          orphaned: total.orphaned + source.orphaned,
          total: total.total + source.total,
          unprocessed: total.unprocessed + source.unprocessed,
        };
      },
      { duplicate: 0, invalid: 0, orphaned: 0, total: 0, unprocessed: 0 }
    ),
    warnings: scannedRows.flatMap((row) => row.status?.warnings ?? []),
  };
};

const sourceWarningLabel = (warning: MigrationStatusWarning): string => {
  switch (warning._tag) {
    case "DuplicateSourceIdentityStatusWarning":
      return `Duplicate ${warning.sourceIdentity} · ${countLabel(warning.count + 1, "occurrence")}`;
    case "InvalidSourceItemStatusWarning":
      return `Invalid ${warning.sourceIdentity} · ${warning.message}`;
    default: {
      const unhandled: never = warning;
      return unhandled;
    }
  }
};

const groupStatusLabel = (rows: readonly MigrationTuiRow[]): string => {
  const labels = rows.map(statusLabel);

  if (labels.includes("running")) {
    return "running";
  }
  if (labels.includes("failed")) {
    return "failed";
  }
  if (labels.includes("needs update")) {
    return "needs update";
  }
  if (labels.every((label) => label === "succeeded")) {
    return "succeeded";
  }
  if (labels.every((label) => label === "loading")) {
    return "loading";
  }

  return "partial";
};

const rowsForGroup = (
  group: MigrationDefinitionRegistryGroup,
  rows: readonly MigrationTuiRow[]
): readonly MigrationTuiRow[] => {
  const rowsById = new Map(rows.map((row) => [row.entry.id, row]));

  return group.definitionIds.flatMap((definitionId) => {
    const row = rowsById.get(definitionId);
    return row === undefined ? [] : [row];
  });
};

const listCountsLabel = (row: MigrationTuiRow): string => {
  if (row.status === undefined) {
    return "Reading status…";
  }

  const counts = durableCounts(row);
  const populated = [
    counts.migrated === 0 ? undefined : `${counts.migrated} migrated`,
    counts.failed === 0 ? undefined : `${counts.failed} failed`,
    counts.skipped === 0 ? undefined : `${counts.skipped} skipped`,
    counts.needsUpdate === 0 ? undefined : `${counts.needsUpdate} to update`,
  ].filter((value): value is string => value !== undefined);

  return populated.length === 0 ? "No item history" : populated.join(" · ");
};

const formatDate = (date: Date | undefined): string => {
  if (date === undefined) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
};

const lastRunLabel = (row: MigrationTuiRow): string => {
  const lastRun = row.status?.lastRun;

  if (lastRun === null || lastRun === undefined) {
    return "never run";
  }

  return `${lastRun.status} · ${formatDate(lastRun.finishedAt ?? lastRun.startedAt)}`;
};

const ProgressBar = ({ counts }: { readonly counts: DurableCounts }) => {
  const segments = [
    { color: migrationColors.success, count: counts.migrated },
    { color: migrationColors.danger, count: counts.failed },
    { color: migrationColors.dim, count: counts.skipped },
    { color: migrationColors.warning, count: counts.needsUpdate },
  ];
  const populated = segments.filter((segment) => segment.count > 0);

  return (
    <box
      backgroundColor={migrationColors.border}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        height: 1,
        width: "100%",
      }}
    >
      {populated.map((segment) => (
        <box
          backgroundColor={segment.color}
          key={segment.color}
          style={{
            flexBasis: 0,
            flexGrow: segment.count,
            flexShrink: 1,
            height: 1,
            minWidth: 1,
          }}
        />
      ))}
    </box>
  );
};

const migrationRowHeight = 2;

const MigrationList = ({
  layout,
  onSelectedIndexChange,
  onSelectCurrent,
  rows,
  selectedIndex,
}: {
  readonly layout: "compact" | "wide";
  readonly onSelectedIndexChange: (index: number) => void;
  readonly onSelectCurrent: () => void;
  readonly rows: readonly MigrationTuiRow[];
  readonly selectedIndex: number;
}) => {
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const selectedRowId = `migration-row-${layout}-${selectedIndex}`;

  useEffect(() => {
    const revealSelectedRow = () => {
      scrollboxRef.current?.scrollChildIntoView(selectedRowId);
    };
    revealSelectedRow();
    const timeouts = [0, 16, 50].map((delay) =>
      setTimeout(revealSelectedRow, delay)
    );

    return () => {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
    };
  }, [selectedRowId]);

  return (
    <scrollbox
      focused={false}
      ref={scrollboxRef}
      scrollX={false}
      scrollY
      style={{ flexGrow: 1 }}
      verticalScrollbarOptions={{ visible: false }}
      viewportCulling
    >
      {rows.map((candidate, index) => {
        const label = statusLabel(candidate);
        const selected = index === selectedIndex;

        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: Migration rows are pointer-selectable alongside global keyboard navigation.
          <box
            backgroundColor={
              selected ? migrationColors.selected : migrationColors.background
            }
            id={`migration-row-${layout}-${index}`}
            key={candidate.entry.id}
            onMouseDown={(event) => {
              if (event.button !== 0) {
                return;
              }

              if (selected) {
                onSelectCurrent();
              } else {
                onSelectedIndexChange(index);
              }
            }}
            style={{
              flexDirection: "column",
              flexShrink: 0,
              height: migrationRowHeight,
              paddingX: 1,
              width: "100%",
            }}
          >
            <box
              style={{
                alignItems: "center",
                flexDirection: "row",
                flexShrink: 0,
                height: 1,
                width: "100%",
              }}
            >
              <text fg={statusColor(label)}>{statusIcon(label)} </text>
              <box
                style={{
                  flexGrow: 1,
                  minWidth: 1,
                  overflow: "hidden",
                }}
              >
                <text
                  content={candidate.entry.id}
                  fg={migrationColors.foreground}
                  wrapMode="none"
                />
              </box>
            </box>
            <text
              content={`  ${listCountsLabel(candidate)}`}
              fg={selected ? "#c9d1d9" : migrationColors.dim}
              wrapMode="none"
            />
          </box>
        );
      })}
    </scrollbox>
  );
};

const GroupList = ({
  groups,
  layout,
  onSelectedIndexChange,
  onSelectCurrent,
  rows,
  selectedIndex,
}: {
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly layout: "compact" | "wide";
  readonly onSelectedIndexChange: (index: number) => void;
  readonly onSelectCurrent: () => void;
  readonly rows: readonly MigrationTuiRow[];
  readonly selectedIndex: number;
}) => {
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const selectedRowId = `group-row-${layout}-${selectedIndex}`;

  useEffect(() => {
    const revealSelectedRow = () => {
      scrollboxRef.current?.scrollChildIntoView(selectedRowId);
    };
    revealSelectedRow();
    const timeouts = [0, 16, 50].map((delay) =>
      setTimeout(revealSelectedRow, delay)
    );

    return () => {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
    };
  }, [selectedRowId]);

  return (
    <scrollbox
      focused={false}
      ref={scrollboxRef}
      scrollX={false}
      scrollY
      style={{ flexGrow: 1 }}
      verticalScrollbarOptions={{ visible: false }}
      viewportCulling
    >
      {groups.map((group, index) => {
        const groupRows = rowsForGroup(group, rows);
        const label = groupStatusLabel(groupRows);
        const counts = aggregateCounts(groupRows);
        const selected = index === selectedIndex;
        const itemSummary = [
          countLabel(groupRows.length, "migration"),
          counts.migrated === 0 ? undefined : `${counts.migrated} migrated`,
          counts.failed === 0 ? undefined : `${counts.failed} failed`,
          counts.needsUpdate === 0
            ? undefined
            : `${counts.needsUpdate} to update`,
        ]
          .filter((value): value is string => value !== undefined)
          .join(" · ");

        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: Group rows are pointer-selectable alongside global keyboard navigation.
          <box
            backgroundColor={
              selected ? migrationColors.selected : migrationColors.background
            }
            id={`group-row-${layout}-${index}`}
            key={group.id}
            onMouseDown={(event) => {
              if (event.button !== 0) {
                return;
              }

              if (selected) {
                onSelectCurrent();
              } else {
                onSelectedIndexChange(index);
              }
            }}
            style={{
              flexDirection: "column",
              flexShrink: 0,
              height: migrationRowHeight,
              paddingX: 1,
              width: "100%",
            }}
          >
            <box
              style={{
                alignItems: "center",
                flexDirection: "row",
                flexShrink: 0,
                height: 1,
                width: "100%",
              }}
            >
              <text fg={statusColor(label)}>{statusIcon(label)} </text>
              <box style={{ flexGrow: 1, minWidth: 1, overflow: "hidden" }}>
                <text
                  content={group.id}
                  fg={migrationColors.foreground}
                  wrapMode="none"
                />
              </box>
            </box>
            <text
              content={`  ${itemSummary}`}
              fg={selected ? "#c9d1d9" : migrationColors.dim}
              wrapMode="none"
            />
          </box>
        );
      })}
    </scrollbox>
  );
};

const CountsRow = ({ counts }: { readonly counts: DurableCounts }) => (
  <box
    style={{
      flexDirection: "row",
      flexShrink: 0,
      height: 1,
      justifyContent: "space-between",
      width: "100%",
    }}
  >
    <text fg={migrationColors.success}>{counts.migrated} migrated</text>
    <text fg={migrationColors.danger}>{counts.failed} failed</text>
    <text fg={migrationColors.dim}>{counts.skipped} skipped</text>
    <text fg={migrationColors.warning}>{counts.needsUpdate} to update</text>
  </box>
);

const SourceInventorySummary = ({
  compact,
  rows,
}: {
  readonly compact: boolean;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const inventory = sourceInventory(rows);

  if (inventory === undefined) {
    return (
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.dim}>Not scanned · press s to scan</text>
      </box>
    );
  }

  const visibleWarnings = inventory.warnings.slice(0, compact ? 1 : 3);
  const hiddenWarningCount = inventory.warnings.length - visibleWarnings.length;

  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height: 1 + visibleWarnings.length + (hiddenWarningCount > 0 ? 1 : 0),
      }}
    >
      <text
        content={`${inventory.counts.total} total · ${inventory.counts.unprocessed} unprocessed · ${inventory.counts.invalid} invalid · ${inventory.counts.duplicate} duplicate · ${inventory.counts.orphaned} orphaned`}
        fg={migrationColors.dim}
        wrapMode="none"
      />
      {visibleWarnings.map((warning, index) => (
        <text
          content={`! ${index + 1}/${inventory.warnings.length} ${sourceWarningLabel(warning)}`}
          fg={migrationColors.warning}
          key={`${warning._tag}-${warning.definitionId}-${warning.sourceIdentity}`}
          wrapMode="none"
        />
      ))}
      {hiddenWarningCount > 0 ? (
        <text fg={migrationColors.dim}>
          {countLabel(hiddenWarningCount, "additional warning")}
        </text>
      ) : null}
    </box>
  );
};

const LockDetails = ({ row }: { readonly row: MigrationTuiRow }) => {
  const lock = row.status?.lock;

  if (lock === null || lock === undefined) {
    return null;
  }

  return (
    <box style={{ flexDirection: "column", flexShrink: 0, height: 4 }}>
      <text fg={migrationColors.foreground}>Lock</text>
      <text
        content={`Owner run  ${lock.ownerRunId}`}
        fg={migrationColors.info}
        wrapMode="none"
      />
      <text
        content={`Created    ${formatDate(lock.createdAt)}`}
        fg={migrationColors.dim}
        wrapMode="none"
      />
      <text
        content={`Token      ${lock.token}`}
        fg={migrationColors.dim}
        wrapMode="none"
      />
    </box>
  );
};

const GroupLocks = ({
  rows,
}: {
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const lockedRows = rows.filter(
    (row) => row.status?.lock !== null && row.status?.lock !== undefined
  );

  if (lockedRows.length === 0) {
    return null;
  }

  return (
    <box
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height: lockedRows.length + 2,
      }}
    >
      <text fg={migrationColors.foreground}>Locks</text>
      {lockedRows.map((row) => (
        <text
          content={`${row.entry.id} · owner run ${row.status?.lock?.ownerRunId}`}
          fg={migrationColors.info}
          key={row.entry.id}
          wrapMode="none"
        />
      ))}
      <text fg={migrationColors.dim}>
        Select a migration to inspect or break its lock.
      </text>
    </box>
  );
};

const Capabilities = ({ row }: { readonly row: MigrationTuiRow }) => (
  <box style={{ flexDirection: "row", flexShrink: 0, gap: 3, height: 1 }}>
    <Checkbox
      checked={row.entry.hasRollback}
      disabled
      label="Rollback"
      tone="success"
    />
    <Checkbox checked disabled label="Source Inventory Scan" tone="success" />
    <Checkbox
      checked={row.status?.discovery === "incremental"}
      disabled
      label="Incremental"
      tone="success"
    />
  </box>
);

const Dependencies = ({
  compact,
  row,
  rows,
}: {
  readonly compact: boolean;
  readonly row: MigrationTuiRow;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const dependencies = [
    ...row.entry.dependencies.required.map((id) => ({ id, kind: "required" })),
    ...row.entry.dependencies.optional.map((id) => ({ id, kind: "optional" })),
  ];
  const rowsById = new Map(
    rows.map((candidate) => [candidate.entry.id, candidate])
  );

  if (dependencies.length === 0) {
    return (
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.dim}>None</text>
      </box>
    );
  }

  if (compact) {
    return (
      <box key="dependencies-compact" style={{ flexShrink: 0, height: 1 }}>
        <text
          content={dependencies
            .map((dependency) => `${dependency.id} ${dependency.kind}`)
            .join(" · ")}
          fg={migrationColors.dim}
          wrapMode="none"
        />
      </box>
    );
  }

  return (
    <box
      key="dependencies-wide"
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height: dependencies.length + 1,
      }}
    >
      <text fg={migrationColors.foreground}>{row.entry.id}</text>
      {dependencies.map((dependency, index) => {
        const dependencyRow = rowsById.get(dependency.id);
        const label =
          dependencyRow === undefined
            ? "status unavailable"
            : statusLabel(dependencyRow);

        return (
          <box
            key={dependency.id}
            style={{ flexDirection: "row", flexShrink: 0, height: 1 }}
          >
            <text fg={migrationColors.dim}>
              {index === dependencies.length - 1 ? "└─" : "├─"}{" "}
            </text>
            <text fg={migrationColors.foreground}>{dependency.id}</text>
            <box style={{ flexGrow: 1 }} />
            <text fg={migrationColors.dim}>{dependency.kind}</text>
            <text fg={statusColor(label)}> {label.toUpperCase()}</text>
          </box>
        );
      })}
    </box>
  );
};

const LatestMessage = ({
  compact,
  loading,
  messages,
  showDefinitionId = false,
}: {
  readonly compact: boolean;
  readonly loading: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly showDefinitionId?: boolean;
}) => {
  const latest = messages[0];

  if (loading) {
    return (
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.dim}>Loading messages…</text>
      </box>
    );
  }
  if (latest === undefined) {
    return (
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.dim}>No messages.</text>
      </box>
    );
  }

  if (compact) {
    return (
      <box key="message-compact" style={{ flexShrink: 0, height: 1 }}>
        <text
          content={`${migrationMessageMarker(latest.severity)} ${showDefinitionId ? `${latest.definitionId} · ` : ""}${latest.sourceIdentity} · ${latest.message}`}
          fg={statusColor(latest.severity)}
          wrapMode="none"
        />
      </box>
    );
  }

  return (
    <box
      key="message-wide"
      style={{ flexDirection: "column", flexShrink: 0, height: 2 }}
    >
      <text fg={statusColor(latest.severity)}>
        {migrationMessageMarker(latest.severity)}{" "}
        {showDefinitionId ? `${latest.definitionId} · ` : ""}
        {latest.sourceIdentity} · {migrationMessageKindLabel(latest.kind)}
      </text>
      <text fg={migrationColors.foreground}>{latest.message}</text>
    </box>
  );
};

const OverviewViewport = ({
  active,
  children,
}: {
  readonly active: boolean;
  readonly children: ReactNode;
}) => {
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useKeyboard((key) => {
    if (!activeRef.current) {
      return;
    }

    if (key.name === "pageup") {
      key.preventDefault();
      key.stopPropagation();
      scrollboxRef.current?.scrollBy(-1, "viewport");
    } else if (key.name === "pagedown") {
      key.preventDefault();
      key.stopPropagation();
      scrollboxRef.current?.scrollBy(1, "viewport");
    } else if (key.name === "home") {
      key.preventDefault();
      key.stopPropagation();
      scrollboxRef.current?.scrollTo(0);
    } else if (key.name === "end") {
      key.preventDefault();
      key.stopPropagation();
      scrollboxRef.current?.scrollTo(Number.MAX_SAFE_INTEGER);
    }
  });

  return (
    <scrollbox
      focused={false}
      ref={scrollboxRef}
      scrollX={false}
      scrollY
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
      verticalScrollbarOptions={{ visible: false }}
      viewportCulling
    >
      {children}
    </scrollbox>
  );
};

const Overview = ({
  active,
  compact,
  messages,
  messagesLoading,
  row,
  rows,
}: {
  readonly active: boolean;
  readonly compact: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly row: MigrationTuiRow;
  readonly rows: readonly MigrationTuiRow[];
}) => (
  <OverviewViewport active={active}>
    <box style={{ flexShrink: 0, height: 1 }}>
      <text fg={migrationColors.foreground}>Items</text>
    </box>
    <ProgressBar counts={durableCounts(row)} />
    <CountsRow counts={durableCounts(row)} />
    <box style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}>
      <text fg={migrationColors.foreground}>Source inventory</text>
    </box>
    <SourceInventorySummary compact={compact} rows={[row]} />
    <LockDetails row={row} />
    <box style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}>
      <text fg={migrationColors.foreground}>Capabilities</text>
    </box>
    <Capabilities row={row} />
    <box style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}>
      <text fg={migrationColors.foreground}>Dependencies</text>
    </box>
    <Dependencies compact={compact} row={row} rows={rows} />
    {compact ? null : (
      <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
        <text fg={migrationColors.foreground}>Latest message</text>
      </box>
    )}
    <LatestMessage
      compact={compact}
      loading={messagesLoading}
      messages={messages}
    />
  </OverviewViewport>
);

const GroupOverview = ({
  active,
  compact,
  messages,
  messagesLoading,
  rows,
}: {
  readonly active: boolean;
  readonly compact: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const counts = aggregateCounts(rows);

  return (
    <OverviewViewport active={active}>
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.foreground}>Items</text>
      </box>
      <ProgressBar counts={counts} />
      <CountsRow counts={counts} />
      <box style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}>
        <text fg={migrationColors.foreground}>Source inventory</text>
      </box>
      <SourceInventorySummary compact={compact} rows={rows} />
      <GroupLocks rows={rows} />
      <box style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}>
        <text fg={migrationColors.foreground}>Migrations</text>
      </box>
      {compact ? (
        <box style={{ flexShrink: 0, height: 1 }}>
          <text
            content={rows.map((row) => row.entry.id).join(" · ")}
            fg={migrationColors.dim}
            wrapMode="none"
          />
        </box>
      ) : (
        rows.map((row) => {
          const label = statusLabel(row);

          return (
            <box
              key={row.entry.id}
              style={{
                flexDirection: "row",
                flexShrink: 0,
                height: 1,
                width: "100%",
              }}
            >
              <text fg={statusColor(label)}>{statusIcon(label)} </text>
              <text fg={migrationColors.foreground}>{row.entry.id}</text>
              <box style={{ flexGrow: 1 }} />
              <text fg={statusColor(label)}>{label}</text>
            </box>
          );
        })
      )}
      <box style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}>
        <text fg={migrationColors.foreground}>Run scope</text>
      </box>
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.dim}>
          {countLabel(rows.length, "migration")} · dependencies outside this
          group are not included
        </text>
      </box>
      {compact ? null : (
        <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
          <text fg={migrationColors.foreground}>Latest message</text>
        </box>
      )}
      <LatestMessage
        compact={compact}
        loading={messagesLoading}
        messages={messages}
        showDefinitionId
      />
    </OverviewViewport>
  );
};

const PrimaryActionButtons = ({
  actions,
  compact,
  disabled,
  onSelectAction,
}: {
  readonly actions: readonly MigrationTuiAvailableAction[];
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly onSelectAction: (action: MigrationTuiAvailableAction) => void;
}) =>
  migrationTuiPrimaryActions(actions).map((action) => {
    const primary = action.primary;

    if (primary === undefined) {
      return null;
    }

    return (
      <Button
        disabled={disabled}
        intent={primary.intent}
        key={action.id}
        label={compact ? primary.compactLabel : primary.label}
        onPress={() => onSelectAction(action)}
      />
    );
  });

const GroupDetailPane = ({
  activeTab,
  actions,
  compact,
  disabled,
  group,
  messageIndex,
  messages,
  messagesLoading,
  onMessageIndexChange,
  onOpenActions,
  onSelectAction,
  onTabChange,
  rows,
}: {
  readonly activeTab: MigrationDetailTab;
  readonly actions: readonly MigrationTuiAvailableAction[];
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly group: MigrationDefinitionRegistryGroup;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messageIndex: number;
  readonly messagesLoading: boolean;
  readonly onMessageIndexChange: (index: number) => void;
  readonly onOpenActions: () => void;
  readonly onSelectAction: (action: MigrationTuiAvailableAction) => void;
  readonly onTabChange: (tab: MigrationDetailTab) => void;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const label = groupStatusLabel(rows);

  return (
    <box
      style={{
        border: true,
        borderColor: migrationColors.border,
        flexDirection: "column",
        flexGrow: 1,
        padding: 1,
      }}
      title="Details"
    >
      <box
        style={{
          alignItems: "center",
          flexDirection: "row",
          flexShrink: 0,
          gap: 1,
          height: 1,
        }}
      >
        <text fg={migrationColors.foreground}>{group.id}</text>
        <Badge intent="neutral" label="GROUP" />
        <Badge intent={statusBadgeIntent(label)} label={label.toUpperCase()} />
      </box>
      <text fg={migrationColors.dim}>
        {countLabel(rows.length, "migration")}
      </text>
      <Tabs
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        onValueChange={(value) => onTabChange(value as MigrationDetailTab)}
        overflow="hidden"
        value={activeTab}
      >
        <TabsList flexShrink={0} height={1} marginTop={1}>
          <TabsTrigger label="Overview" value="overview" />
          <TabsTrigger label={`Messages ${messages.length}`} value="messages" />
        </TabsList>
        <TabsContent
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          value="overview"
        >
          <GroupOverview
            active={activeTab === "overview"}
            compact={compact}
            key={`group-overview-${group.id}`}
            messages={messages}
            messagesLoading={messagesLoading}
            rows={rows}
          />
        </TabsContent>
        <TabsContent
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          value="messages"
        >
          <MigrationMessages
            colors={migrationColors}
            compact={compact}
            key={`group-messages-${group.id}`}
            loading={messagesLoading}
            messages={messages}
            onSelectedIndexChange={onMessageIndexChange}
            selectedIndex={messageIndex}
            severityColor={statusColor}
            showDefinitionId
          />
        </TabsContent>
      </Tabs>
      <box
        style={{
          flexDirection: "row",
          flexShrink: 0,
          gap: 1,
          height: 1,
          marginTop: compact ? 0 : 1,
        }}
      >
        <PrimaryActionButtons
          actions={actions}
          compact={compact}
          disabled={disabled}
          onSelectAction={onSelectAction}
        />
        <Button
          disabled={disabled}
          intent="neutral"
          label={compact ? "↵ More" : "↵ All actions"}
          onPress={onOpenActions}
        />
      </box>
    </box>
  );
};

const DetailPane = ({
  activeTab,
  actions,
  compact,
  disabled,
  messages,
  messageIndex,
  messagesLoading,
  onMessageIndexChange,
  onOpenActions,
  onSelectAction,
  onTabChange,
  row,
  rows,
}: {
  readonly activeTab: MigrationDetailTab;
  readonly actions: readonly MigrationTuiAvailableAction[];
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messageIndex: number;
  readonly messagesLoading: boolean;
  readonly onMessageIndexChange: (index: number) => void;
  readonly onOpenActions: () => void;
  readonly onSelectAction: (action: MigrationTuiAvailableAction) => void;
  readonly onTabChange: (tab: MigrationDetailTab) => void;
  readonly row: MigrationTuiRow;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const label = statusLabel(row);

  return (
    <box
      style={{
        border: true,
        borderColor: migrationColors.border,
        flexDirection: "column",
        flexGrow: 1,
        padding: 1,
      }}
      title="Details"
    >
      <box
        style={{
          alignItems: "center",
          flexDirection: "row",
          flexShrink: 0,
          gap: 1,
          height: 1,
        }}
      >
        <text fg={migrationColors.foreground}>{row.entry.id}</text>
        <Badge intent={statusBadgeIntent(label)} label={label.toUpperCase()} />
      </box>
      <text fg={migrationColors.dim}>
        {row.entry.group === undefined ? "standalone" : row.entry.group} ·{" "}
        {lastRunLabel(row)}
      </text>
      <Tabs
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        onValueChange={(value) => onTabChange(value as MigrationDetailTab)}
        overflow="hidden"
        value={activeTab}
      >
        <TabsList flexShrink={0} height={1} marginTop={1}>
          <TabsTrigger label="Overview" value="overview" />
          <TabsTrigger label={`Messages ${messages.length}`} value="messages" />
        </TabsList>
        <TabsContent
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          value="overview"
        >
          <Overview
            active={activeTab === "overview"}
            compact={compact}
            key={`migration-overview-${row.entry.id}`}
            messages={messages}
            messagesLoading={messagesLoading}
            row={row}
            rows={rows}
          />
        </TabsContent>
        <TabsContent
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          overflow="hidden"
          value="messages"
        >
          <MigrationMessages
            colors={migrationColors}
            compact={compact}
            key={`migration-messages-${row.entry.id}`}
            loading={messagesLoading}
            messages={messages}
            onSelectedIndexChange={onMessageIndexChange}
            selectedIndex={messageIndex}
            severityColor={statusColor}
          />
        </TabsContent>
      </Tabs>
      <box
        style={{
          flexDirection: "row",
          flexShrink: 0,
          gap: 1,
          height: 1,
          marginTop: compact ? 0 : 1,
        }}
      >
        <PrimaryActionButtons
          actions={actions}
          compact={compact}
          disabled={disabled}
          onSelectAction={onSelectAction}
        />
        <Button
          disabled={disabled}
          intent="neutral"
          label={compact ? "↵ More" : "↵ All actions"}
          onPress={onOpenActions}
        />
      </box>
    </box>
  );
};

export const MigrationDashboard = ({
  activeTab,
  actions,
  busy,
  groups,
  listTab,
  messages,
  messageIndex,
  messagesLoading,
  onListTabChange,
  onMessageIndexChange,
  onOpenActions,
  onSelectAction,
  onSelectedIndexChange,
  onSelectCurrent,
  onTabChange,
  rows,
  selectedIndex,
  terminalWidth,
}: {
  readonly activeTab: MigrationDetailTab;
  readonly actions: readonly MigrationTuiAvailableAction[];
  readonly busy: string;
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly listTab: MigrationListTab;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messageIndex: number;
  readonly messagesLoading: boolean;
  readonly onListTabChange: (tab: MigrationListTab) => void;
  readonly onMessageIndexChange: (index: number) => void;
  readonly onOpenActions: () => void;
  readonly onSelectAction: (action: MigrationTuiAvailableAction) => void;
  readonly onSelectedIndexChange: (index: number) => void;
  readonly onSelectCurrent: () => void;
  readonly onTabChange: (tab: MigrationDetailTab) => void;
  readonly rows: readonly MigrationTuiRow[];
  readonly selectedIndex: number;
  readonly terminalWidth: number;
}) => {
  const row = rows[selectedIndex] ?? rows[0];
  const group = groups[selectedIndex] ?? groups[0];
  const groupRows = group === undefined ? [] : rowsForGroup(group, rows);
  const visibleCount = listTab === "groups" ? groups.length : rows.length;
  const wide = terminalWidth >= 92;
  const listHeight = wide
    ? "100%"
    : Math.min(10, Math.max(8, visibleCount * migrationRowHeight + 3));
  const primaryShortcuts = migrationTuiPrimaryActions(actions).flatMap(
    (action) =>
      action.shortcutLabel === undefined ? [] : [action.shortcutLabel]
  );
  const utilityShortcuts = migrationTuiUtilityActions(actions).flatMap(
    (action) =>
      action.shortcutLabel === undefined ? [] : [action.shortcutLabel]
  );

  if (
    (listTab === "migrations" && row === undefined) ||
    (listTab === "groups" && group === undefined)
  ) {
    return null;
  }

  let detailPane: ReactNode = null;

  if (listTab === "groups" && group !== undefined) {
    detailPane = (
      <GroupDetailPane
        actions={actions}
        activeTab={activeTab}
        compact={!wide}
        disabled={busy !== ""}
        group={group}
        messageIndex={messageIndex}
        messages={messages}
        messagesLoading={messagesLoading}
        onMessageIndexChange={onMessageIndexChange}
        onOpenActions={onOpenActions}
        onSelectAction={onSelectAction}
        onTabChange={onTabChange}
        rows={groupRows}
      />
    );
  } else if (row !== undefined) {
    detailPane = (
      <DetailPane
        actions={actions}
        activeTab={activeTab}
        compact={!wide}
        disabled={busy !== ""}
        messageIndex={messageIndex}
        messages={messages}
        messagesLoading={messagesLoading}
        onMessageIndexChange={onMessageIndexChange}
        onOpenActions={onOpenActions}
        onSelectAction={onSelectAction}
        onTabChange={onTabChange}
        row={row}
        rows={rows}
      />
    );
  }

  return (
    <>
      <box
        style={{
          flexDirection: wide ? "row" : "column",
          flexGrow: 1,
          gap: 1,
          marginTop: 1,
        }}
      >
        <box
          style={{
            border: true,
            borderColor: migrationColors.border,
            flexDirection: "column",
            flexShrink: 0,
            height: listHeight,
            paddingX: 1,
            width: wide ? "37%" : "100%",
          }}
          title={`Browse  ${rows.length + groups.length}`}
        >
          <Tabs
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            onValueChange={(value) =>
              onListTabChange(value as MigrationListTab)
            }
            overflow="hidden"
            value={listTab}
          >
            <TabsList flexShrink={0} height={1}>
              <TabsTrigger
                label={`Migrations ${rows.length}`}
                value="migrations"
              />
              <TabsTrigger
                disabled={groups.length === 0}
                label={`Groups ${groups.length}`}
                value="groups"
              />
            </TabsList>
            <TabsContent
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              overflow="hidden"
              value="migrations"
            >
              <MigrationList
                layout={wide ? "wide" : "compact"}
                onSelectCurrent={onSelectCurrent}
                onSelectedIndexChange={onSelectedIndexChange}
                rows={rows}
                selectedIndex={selectedIndex}
              />
            </TabsContent>
            <TabsContent
              flexDirection="column"
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              overflow="hidden"
              value="groups"
            >
              <GroupList
                groups={groups}
                layout={wide ? "wide" : "compact"}
                onSelectCurrent={onSelectCurrent}
                onSelectedIndexChange={onSelectedIndexChange}
                rows={rows}
                selectedIndex={selectedIndex}
              />
            </TabsContent>
          </Tabs>
        </box>
        {detailPane}
      </box>
      <box
        key={wide ? "wide-shortcuts" : "compact-shortcuts"}
        style={{
          flexDirection: "column",
          flexShrink: 0,
          height: 3,
          marginTop: 1,
        }}
      >
        <text
          content={
            activeTab === "overview"
              ? `↑↓ select · g ${wide ? "migrations/groups" : "view"} · ↵ ${wide ? "all actions" : "more"} · PgUp/PgDn details`
              : `↑↓ select · g ${wide ? "migrations/groups" : "view"} · ↵ ${wide ? "all actions" : "more"}`
          }
          fg={migrationColors.info}
          wrapMode="none"
        />
        <text
          content={primaryShortcuts.join(" · ")}
          fg={migrationColors.dim}
          wrapMode="none"
        />
        <text
          content={`${utilityShortcuts.join(" · ")} · R ${wide ? "reload status" : "reload"} · ${busy === "" ? "q quit" : "q cancel + quit"}`}
          fg={migrationColors.dim}
          wrapMode="none"
        />
      </box>
    </>
  );
};
