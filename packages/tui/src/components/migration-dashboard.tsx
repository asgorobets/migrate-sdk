import type { ScrollBoxRenderable } from "@opentui/core";
import type { MigrationDefinitionRegistryGroup } from "migrate-sdk";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import type {
  MigrationTuiAction,
  MigrationTuiMessage,
  MigrationTuiRow,
} from "../runtime.ts";
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

const messageMarker = (severity: MigrationTuiMessage["severity"]): string => {
  if (severity === "error") {
    return "✗";
  }
  if (severity === "warning") {
    return "!";
  }

  return "•";
};

const messageSourceLabel = (source: MigrationTuiMessage["source"]): string =>
  source === "diagnostic" ? "message" : source;

const MessageLine = ({
  message,
}: {
  readonly message: MigrationTuiMessage;
}) => (
  <box style={{ flexDirection: "column", marginBottom: 1 }}>
    <text fg={statusColor(message.severity)}>
      {messageMarker(message.severity)} {message.identity} ·{" "}
      {messageSourceLabel(message.source)}
    </text>
    <text fg={migrationColors.foreground}>{message.message}</text>
    {message.details === undefined ? null : (
      <text fg={migrationColors.dim}>{message.details}</text>
    )}
  </box>
);

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

const Capabilities = ({ row }: { readonly row: MigrationTuiRow }) => (
  <box style={{ flexDirection: "row", flexShrink: 0, gap: 3, height: 1 }}>
    <Checkbox
      checked={row.entry.hasRollback}
      disabled
      label="Rollback"
      tone="success"
    />
    <Checkbox checked disabled label="Source scan" tone="success" />
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

const LatestDiagnostic = ({
  compact,
  loading,
  messages,
}: {
  readonly compact: boolean;
  readonly loading: boolean;
  readonly messages: readonly MigrationTuiMessage[];
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
      <box key="diagnostic-compact" style={{ flexShrink: 0, height: 1 }}>
        <text
          content={`${messageMarker(latest.severity)} ${latest.identity} · ${latest.message}`}
          fg={statusColor(latest.severity)}
          wrapMode="none"
        />
      </box>
    );
  }

  return (
    <box
      key="diagnostic-wide"
      style={{ flexDirection: "column", flexShrink: 0, height: 2 }}
    >
      <text fg={statusColor(latest.severity)}>
        {messageMarker(latest.severity)} {latest.identity} ·{" "}
        {messageSourceLabel(latest.source)}
      </text>
      <text fg={migrationColors.foreground}>{latest.message}</text>
    </box>
  );
};

const Overview = ({
  compact,
  messages,
  messagesLoading,
  row,
  rows,
}: {
  readonly compact: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly row: MigrationTuiRow;
  readonly rows: readonly MigrationTuiRow[];
}) => (
  <scrollbox
    focused={false}
    scrollX={false}
    scrollY
    style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
    verticalScrollbarOptions={{ visible: false }}
    viewportCulling
  >
    <box style={{ flexShrink: 0, height: 1 }}>
      <text fg={migrationColors.foreground}>Items</text>
    </box>
    <ProgressBar counts={durableCounts(row)} />
    <CountsRow counts={durableCounts(row)} />
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
    <LatestDiagnostic
      compact={compact}
      loading={messagesLoading}
      messages={messages}
    />
  </scrollbox>
);

const Messages = ({
  loading,
  messages,
  onBack,
}: {
  readonly loading: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly onBack: () => void;
}) => (
  // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI scrollboxes own scrolling keys.
  <scrollbox
    focused
    onKeyDown={(key) => {
      if (key.name === "escape") {
        onBack();
      }
    }}
    style={{ flexGrow: 1, marginTop: 1 }}
    verticalScrollbarOptions={{ visible: false }}
  >
    {loading ? <text fg={migrationColors.dim}>Loading messages…</text> : null}
    {!loading && messages.length === 0 ? (
      <text fg={migrationColors.dim}>No messages.</text>
    ) : null}
    {loading || messages.length === 0
      ? null
      : messages.map((message) => (
          <MessageLine
            key={`${message.identity}-${message.source}-${message.updatedAt.toISOString()}-${message.message}`}
            message={message}
          />
        ))}
  </scrollbox>
);

const GroupOverview = ({
  compact,
  messages,
  messagesLoading,
  rows,
}: {
  readonly compact: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const counts = aggregateCounts(rows);

  return (
    <scrollbox
      focused={false}
      scrollX={false}
      scrollY
      style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
      verticalScrollbarOptions={{ visible: false }}
      viewportCulling
    >
      <box style={{ flexShrink: 0, height: 1 }}>
        <text fg={migrationColors.foreground}>Items</text>
      </box>
      <ProgressBar counts={counts} />
      <CountsRow counts={counts} />
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
      <LatestDiagnostic
        compact={compact}
        loading={messagesLoading}
        messages={messages}
      />
    </scrollbox>
  );
};

const GroupDetailPane = ({
  activeTab,
  compact,
  disabled,
  group,
  messages,
  messagesLoading,
  onAction,
  onBackToOverview,
  onOpenActions,
  onTabChange,
  rows,
}: {
  readonly activeTab: MigrationDetailTab;
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly group: MigrationDefinitionRegistryGroup;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly onAction: (action: MigrationTuiAction) => void;
  readonly onBackToOverview: () => void;
  readonly onOpenActions: () => void;
  readonly onTabChange: (tab: MigrationDetailTab) => void;
  readonly rows: readonly MigrationTuiRow[];
}) => {
  const label = groupStatusLabel(rows);
  const failed = aggregateCounts(rows).failed;
  const canRollback =
    rows.length > 0 && rows.every((row) => row.entry.hasRollback);

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
            compact={compact}
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
          <Messages
            loading={messagesLoading}
            messages={messages}
            onBack={onBackToOverview}
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
        <Button
          disabled={disabled}
          label={compact ? "r Run" : "r Run group"}
          onPress={() => onAction("run")}
        />
        {failed > 0 ? (
          <Button
            disabled={disabled}
            intent="warning"
            label={compact ? "f Retry" : "f Retry failed"}
            onPress={() => onAction("retry-failed")}
          />
        ) : null}
        {canRollback ? (
          <Button
            disabled={disabled}
            intent="neutral"
            label={compact ? "b Rollback" : "b Rollback group"}
            onPress={() => onAction("rollback")}
          />
        ) : null}
        <Button
          disabled={disabled}
          intent="neutral"
          label="↵ Actions"
          onPress={onOpenActions}
        />
      </box>
    </box>
  );
};

const DetailPane = ({
  activeTab,
  compact,
  disabled,
  messages,
  messagesLoading,
  onAction,
  onBackToOverview,
  onOpenActions,
  onTabChange,
  row,
  rows,
}: {
  readonly activeTab: MigrationDetailTab;
  readonly compact: boolean;
  readonly disabled: boolean;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly onAction: (action: MigrationTuiAction) => void;
  readonly onBackToOverview: () => void;
  readonly onOpenActions: () => void;
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
            compact={compact}
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
          <Messages
            loading={messagesLoading}
            messages={messages}
            onBack={onBackToOverview}
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
        <Button
          disabled={disabled}
          label="r Run"
          onPress={() => onAction("run")}
        />
        {(row.status?.durable.failed ?? 0) > 0 ? (
          <Button
            disabled={disabled}
            intent="warning"
            label={compact ? "f Retry" : "f Retry failed"}
            onPress={() => onAction("retry-failed")}
          />
        ) : null}
        {row.entry.hasRollback ? (
          <Button
            disabled={disabled}
            intent="neutral"
            label="b Rollback"
            onPress={() => onAction("rollback")}
          />
        ) : null}
        <Button
          disabled={disabled}
          intent="neutral"
          label="↵ Actions"
          onPress={onOpenActions}
        />
      </box>
    </box>
  );
};

export const MigrationDashboard = ({
  activeTab,
  busy,
  groups,
  listTab,
  messages,
  messagesLoading,
  onAction,
  onBackToOverview,
  onListTabChange,
  onOpenActions,
  onSelectedIndexChange,
  onSelectCurrent,
  onTabChange,
  rows,
  selectedIndex,
  terminalWidth,
}: {
  readonly activeTab: MigrationDetailTab;
  readonly busy: string;
  readonly groups: readonly MigrationDefinitionRegistryGroup[];
  readonly listTab: MigrationListTab;
  readonly messages: readonly MigrationTuiMessage[];
  readonly messagesLoading: boolean;
  readonly onAction: (action: MigrationTuiAction) => void;
  readonly onBackToOverview: () => void;
  readonly onListTabChange: (tab: MigrationListTab) => void;
  readonly onOpenActions: () => void;
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
        activeTab={activeTab}
        compact={!wide}
        disabled={busy !== ""}
        group={group}
        messages={messages}
        messagesLoading={messagesLoading}
        onAction={onAction}
        onBackToOverview={onBackToOverview}
        onOpenActions={onOpenActions}
        onTabChange={onTabChange}
        rows={groupRows}
      />
    );
  } else if (row !== undefined) {
    detailPane = (
      <DetailPane
        activeTab={activeTab}
        compact={!wide}
        disabled={busy !== ""}
        messages={messages}
        messagesLoading={messagesLoading}
        onAction={onAction}
        onBackToOverview={onBackToOverview}
        onOpenActions={onOpenActions}
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
      {wide ? (
        <box
          key="wide-shortcuts"
          style={{
            flexDirection: "row",
            flexShrink: 0,
            gap: 1,
            height: 1,
            marginTop: 1,
          }}
        >
          <text fg={migrationColors.info}>↑↓ select</text>
          <text fg={migrationColors.dim}>g migrations/groups</text>
          <text fg={migrationColors.dim}>↵ actions</text>
          <text fg={migrationColors.dim}>r run</text>
          <text fg={migrationColors.dim}>e entries</text>
          <text fg={migrationColors.dim}>f retry failed</text>
          <text fg={migrationColors.dim}>b rollback</text>
          <text fg={migrationColors.dim}>m messages</text>
          <text fg={migrationColors.dim}>s scan</text>
          <text fg={migrationColors.dim}>R reload status</text>
          <text fg={migrationColors.dim}>
            {busy === "" ? "q quit" : "q cancel + quit"}
          </text>
        </box>
      ) : (
        <box
          key="compact-shortcuts"
          style={{
            flexDirection: "column",
            flexShrink: 0,
            height: 2,
            marginTop: 1,
          }}
        >
          <text fg={migrationColors.info}>
            ↑↓ select · g migrations/groups · ↵ actions · r run · e entries
          </text>
          <text fg={migrationColors.dim}>
            f retry · m messages · s scan · R reload status ·{" "}
            {busy === "" ? "q quit" : "q cancel + quit"}
          </text>
        </box>
      )}
    </>
  );
};
