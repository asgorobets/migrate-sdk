/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type {
  SessionActivityEntry,
  SessionActivityKind,
} from "../session-activity.ts";
import { migrationColors as colors } from "./migration-dashboard.tsx";
import { Badge, type BadgeIntent } from "./ui/badge.tsx";

export const sessionActivityKindPresentation = (
  kind: SessionActivityKind
): {
  readonly color: string;
  readonly icon: string;
  readonly intent: BadgeIntent;
  readonly label: string;
} => {
  switch (kind) {
    case "error":
      return {
        color: colors.danger,
        icon: "×",
        intent: "danger",
        label: "ERROR",
      };
    case "notice":
      return {
        color: colors.success,
        icon: "✓",
        intent: "success",
        label: "NOTICE",
      };
    case "status":
      return {
        color: colors.info,
        icon: "•",
        intent: "neutral",
        label: "STATUS",
      };
    case "warning":
      return {
        color: colors.warning,
        icon: "!",
        intent: "warning",
        label: "WARNING",
      };
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
};

const activityTime = (date: Date): string =>
  date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

export interface SessionActivityProps {
  readonly entries: readonly SessionActivityEntry[];
  readonly environmentLabel: string;
  readonly height: number;
  readonly omitted: number;
  readonly selectedIndex: number;
}

export const SessionActivity = ({
  entries,
  environmentLabel,
  height,
  omitted,
  selectedIndex,
}: SessionActivityProps) => {
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const selected = entries[selectedIndex];

  useEffect(() => {
    if (selected === undefined) {
      return;
    }

    const revealSelectedEntry = () => {
      const scrollbox = scrollboxRef.current;

      if (scrollbox === null || scrollbox.viewport.height === 0) {
        return;
      }

      const rowTop = selectedIndex + (omitted > 0 ? 1 : 0);
      const rowBottom = rowTop + 1;
      const viewportTop = scrollbox.scrollTop;
      const viewportBottom = viewportTop + scrollbox.viewport.height;

      if (rowTop < viewportTop) {
        scrollbox.scrollTo(rowTop);
      } else if (rowBottom > viewportBottom) {
        scrollbox.scrollTo(Math.max(0, rowBottom - scrollbox.viewport.height));
      }
    };
    revealSelectedEntry();
    const timeout = setTimeout(revealSelectedEntry, 0);

    return () => clearTimeout(timeout);
  }, [omitted, selected, selectedIndex]);

  return (
    <box
      style={{
        backgroundColor: colors.background,
        flexDirection: "column",
        height,
        padding: 1,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          flexShrink: 0,
          height: 1,
          justifyContent: "space-between",
          width: "100%",
        }}
      >
        <text fg={colors.foreground}>Migrate</text>
        <text fg={colors.dim}>{environmentLabel}</text>
      </box>
      <box
        style={{
          flexDirection: "row",
          flexShrink: 0,
          height: 1,
          justifyContent: "space-between",
          marginTop: 1,
        }}
      >
        <text fg={colors.foreground}>Session activity</text>
        <Badge intent="neutral" label={`${entries.length} RETAINED`} />
      </box>
      <text
        content="Events observed by this TUI session."
        fg={colors.dim}
        wrapMode="none"
      />
      <scrollbox
        focused={false}
        ref={scrollboxRef}
        scrollX={false}
        scrollY
        style={{
          border: true,
          borderColor: colors.border,
          flexGrow: 1,
          flexShrink: 1,
          marginTop: 1,
          minHeight: 0,
          paddingX: 1,
        }}
        verticalScrollbarOptions={{ visible: false }}
        viewportCulling
      >
        {omitted === 0 ? null : (
          <text
            content={`  … ${omitted} earlier session ${omitted === 1 ? "event" : "events"} omitted`}
            fg={colors.dim}
            wrapMode="none"
          />
        )}
        {entries.length === 0 ? (
          <text content="No activity yet." fg={colors.dim} />
        ) : (
          entries.map((entry, index) => {
            const presentation = sessionActivityKindPresentation(entry.kind);

            return (
              <box
                backgroundColor={
                  index === selectedIndex ? colors.selected : colors.background
                }
                key={entry.sequence}
                style={{
                  flexDirection: "row",
                  flexShrink: 0,
                  height: 1,
                  width: "100%",
                }}
              >
                <text
                  content={`${index === selectedIndex ? "›" : " "} ${String(entry.sequence).padStart(4)} ${activityTime(entry.occurredAt)} ${presentation.icon} `}
                  fg={presentation.color}
                  wrapMode="none"
                />
                <text
                  content={entry.message.replaceAll("\n", " ")}
                  fg={colors.foreground}
                  wrapMode="none"
                />
              </box>
            );
          })
        )}
      </scrollbox>
      {selected === undefined ? null : (
        <box
          style={{
            border: true,
            borderColor: colors.border,
            flexDirection: "column",
            flexShrink: 0,
            height: 4,
            marginTop: 1,
            overflow: "hidden",
            paddingX: 1,
          }}
          title={`Event ${selected.sequence}`}
        >
          <text
            content={`${activityTime(selected.occurredAt)} · ${sessionActivityKindPresentation(selected.kind).label}`}
            fg={sessionActivityKindPresentation(selected.kind).color}
            wrapMode="none"
          />
          <text
            content={selected.message}
            fg={colors.foreground}
            wrapMode="word"
          />
        </box>
      )}
      <box
        style={{
          flexDirection: "column",
          flexShrink: 0,
          height: 2,
          marginTop: 1,
        }}
      >
        <text
          content={
            entries.length === 0
              ? "esc back"
              : `${selectedIndex + 1}/${entries.length} · ↑↓/jk move · PgUp/PgDn jump · Home/End`
          }
          fg={colors.info}
          wrapMode="none"
        />
        <text
          content="↵ expand · e export JSONL · esc back"
          fg={colors.dim}
          wrapMode="none"
        />
      </box>
    </box>
  );
};
