/** @jsxImportSource @opentui/react */

import { type KeyEvent, RGBA } from "@opentui/core";
import { Input } from "@tuiparts/react/input";
import type { MigrationDefinitionId } from "migrate-sdk";
import type { MigrateSourceIdentityHistoryEntry } from "migrate-sdk/protocol";
import { type ElementRef, useEffect, useRef } from "react";
import { migrationColors as colors } from "./migration-dashboard.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.tsx";

const historyStatusPresentation = (
  status: MigrateSourceIdentityHistoryEntry["status"]
): {
  readonly color: string;
  readonly icon: string;
  readonly label: string;
} => {
  switch (status) {
    case "migrated":
      return { color: colors.success, icon: "✓", label: "MIGRATED" };
    case "failed":
      return { color: colors.danger, icon: "×", label: "FAILED" };
    case "needs-update":
      return { color: colors.warning, icon: "!", label: "NEEDS UPDATE" };
    case "skipped":
      return { color: colors.dim, icon: "○", label: "SKIPPED" };
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
};

const countLabel = (
  count: number,
  singular: string,
  plural = `${singular}s`
): string => `${count} ${count === 1 ? singular : plural}`;

export interface SelectiveRunDialogProps {
  readonly action: "rollback" | "run";
  readonly definitionId: MigrationDefinitionId;
  readonly draft: string;
  readonly entries: readonly string[];
  readonly feedback?: {
    readonly message: string;
    readonly tone: "error" | "info";
  };
  readonly height: number;
  readonly history: readonly MigrateSourceIdentityHistoryEntry[];
  readonly historyIndex: number;
  readonly historyLoading: boolean;
  readonly inputReady: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly onSubmit: (value: string) => void;
  readonly width: number;
}

export const SelectiveRunDialog = ({
  action,
  definitionId,
  draft,
  entries,
  feedback,
  height,
  history,
  historyIndex,
  historyLoading,
  inputReady,
  onCancel,
  onDraftChange,
  onKeyDown,
  onConfirm,
  onSubmit,
  width,
}: SelectiveRunDialogProps) => {
  const inputRef = useRef<ElementRef<typeof Input>>(null);
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(76, width - (compact ? 8 : 4)));
  const visibleEntryLimit = compact ? 3 : 4;
  const visibleHistoryLimit = compact ? 3 : 4;
  const visibleEntries = entries.slice(-visibleEntryLimit);
  const historyStart = Math.max(
    0,
    Math.min(
      historyIndex - visibleHistoryLimit + 1,
      history.length - visibleHistoryLimit
    )
  );
  const visibleHistory = history.slice(
    historyStart,
    historyStart + visibleHistoryLimit
  );
  const selectedOverflow = Math.max(0, entries.length - visibleEntries.length);
  const historyRows = Math.max(1, visibleHistory.length);
  const dialogHeight = Math.max(
    1,
    Math.min(16 + visibleEntries.length + historyRows, height - 4)
  );
  const actionLabel = action === "rollback" ? "Rollback" : "Run";

  useEffect(() => {
    if (inputReady) {
      inputRef.current?.focus();
    }
  }, [inputReady]);

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
        borderColor={colors.info}
        focusedBorderColor={colors.info}
        height={dialogHeight}
        maxWidth={dialogWidth}
        onKeyDown={onKeyDown}
        overflow="hidden"
        paddingLeft={compact ? 1 : 2}
        paddingRight={compact ? 1 : 2}
        width={dialogWidth}
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
          <DialogTitle content={`${actionLabel} selected entries`} />
          <Badge intent="neutral" label="SOURCE IDS" />
        </box>
        <DialogDescription
          content={`${definitionId} · ${actionLabel} only the source identities below.`}
          wrapMode="none"
        />
        <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
          <text fg={colors.foreground}>Source identity</text>
        </box>
        <box
          style={{
            border: true,
            borderColor: colors.info,
            flexDirection: "row",
            flexShrink: 0,
            height: 3,
            paddingLeft: 1,
            paddingRight: 1,
            width: "100%",
          }}
        >
          <Input
            onInput={onDraftChange}
            onSubmit={onSubmit}
            placeholder="Enter source identity"
            placeholderColor={colors.dim}
            ref={inputRef}
            textColor={colors.foreground}
            value={draft}
            width="100%"
          />
        </box>
        <box style={{ flexShrink: 0, height: 1 }}>
          <text fg={feedback?.tone === "error" ? colors.danger : colors.dim}>
            {feedback?.message ?? "Press Enter to add."}
          </text>
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
          <text fg={colors.foreground}>Selected entries</text>
          <text fg={colors.dim}>{entries.length} selected</text>
        </box>
        {selectedOverflow === 0 ? null : (
          <text fg={colors.dim}>… {selectedOverflow} more selected</text>
        )}
        {visibleEntries.map((entry, index) => (
          <box
            key={entry}
            style={{ flexDirection: "row", flexShrink: 0, height: 1 }}
          >
            <text fg={colors.info}>✓ </text>
            <text fg={colors.dim}>{selectedOverflow + index + 1}. </text>
            <text fg={colors.foreground}>{entry}</text>
          </box>
        ))}
        <box
          style={{
            flexDirection: "row",
            flexShrink: 0,
            height: 1,
            justifyContent: "space-between",
            marginTop: 1,
          }}
        >
          <text fg={colors.foreground}>History</text>
          <text fg={colors.dim}>{countLabel(history.length, "item")}</text>
        </box>
        {historyLoading ? <text fg={colors.dim}>Loading history…</text> : null}
        {!historyLoading && visibleHistory.length === 0 ? (
          <text fg={colors.dim}>No previous source identities.</text>
        ) : null}
        {visibleHistory.map((entry, index) => {
          const absoluteIndex = historyStart + index;
          const selected = entries.includes(entry.sourceIdentity);
          const focused = absoluteIndex === historyIndex;
          const status = historyStatusPresentation(entry.status);

          return (
            <box
              backgroundColor={focused ? colors.selected : colors.surface}
              key={entry.sourceIdentity}
              style={{ flexDirection: "row", flexShrink: 0, height: 1 }}
            >
              <text fg={selected ? colors.info : colors.dim}>
                {selected ? "[x] " : "[ ] "}
              </text>
              <text fg={status.color}>{status.icon} </text>
              <text fg={colors.foreground}>{entry.sourceIdentity}</text>
              <box style={{ flexGrow: 1 }} />
              <text fg={status.color}>{status.label}</text>
            </box>
          );
        })}
        <box
          style={{
            flexDirection: "row-reverse",
            flexShrink: 0,
            gap: 1,
            height: 1,
            marginTop: 1,
          }}
        >
          <Button
            disabled={entries.length === 0}
            intent={action === "rollback" ? "warning" : "primary"}
            label={`↵ ${actionLabel} ${countLabel(entries.length, "entry", "entries")}`}
            onPress={onConfirm}
          />
          <Button intent="neutral" label="esc Cancel" onPress={onCancel} />
        </box>
        <box
          style={{
            flexDirection: "row",
            flexShrink: 0,
            height: 1,
            justifyContent: "flex-end",
          }}
        >
          <text fg={colors.dim}>
            ↑↓ history · space toggle · enter add/run · ctrl+⌫ remove
          </text>
        </box>
      </DialogContent>
    </Dialog>
  );
};
