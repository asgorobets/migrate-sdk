/** @jsxImportSource @opentui/react */

import { type KeyEvent, RGBA } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { Input } from "@tuiparts/react/input";
import type {
  MigrateSourceIdentityHistoryEntry,
  MigrateTarget,
} from "migrate-sdk/protocol";
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
import { NumberField, type NumberFieldInputRef } from "./ui/number-field.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";

export type SelectiveRunMode = "next-items" | "source-ids";

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
  readonly limit: number | null;
  readonly mode: SelectiveRunMode;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onDraftChange: (value: string) => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly onLimitChange: (value: number | null) => void;
  readonly onModeChange: (mode: SelectiveRunMode) => void;
  readonly onSubmit: (value: string) => void;
  readonly target: MigrateTarget;
  readonly width: number;
}

const selectiveDialogLayout = ({
  width,
  height,
  nextItems,
  showModes,
  entries,
  history,
  historyIndex,
}: Pick<
  SelectiveRunDialogProps,
  "width" | "height" | "entries" | "history" | "historyIndex"
> & { readonly nextItems: boolean; readonly showModes: boolean }) => {
  const compact = width < 80 || height < 28;
  const dialogWidth = Math.max(1, Math.min(76, width - (compact ? 8 : 4)));
  const baseRows = 17 + (showModes ? 3 : 0) - (compact ? 3 : 0);
  const availableRows = Math.max(2, height - 4 - baseRows);
  const visibleEntryLimit = Math.min(
    compact ? 2 : 4,
    Math.max(1, Math.floor(availableRows / 2))
  );
  const selectedRows = Math.min(entries.length, visibleEntryLimit);
  const overflowRows = entries.length > visibleEntryLimit ? 1 : 0;
  const visibleHistoryLimit = Math.max(
    1,
    Math.min(compact ? 2 : 4, availableRows - selectedRows - overflowRows)
  );
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
    Math.min(
      nextItems
        ? 18
        : baseRows + visibleEntries.length + historyRows + overflowRows,
      height - 4
    )
  );
  return {
    compact,
    dialogWidth,
    dialogHeight,
    visibleEntries,
    visibleHistory,
    selectedOverflow,
    historyStart,
  };
};

export const SelectiveRunDialog = ({
  action,
  target,
  mode,
  limit,
  onModeChange,
  onLimitChange,
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
  const limitRef = useRef<NumberFieldInputRef>(null);
  const focusedInitialInput = useRef(false);
  const nextItems = action === "run" && mode === "next-items";
  const showModes = action === "run" && target.kind === "migration";
  const validLimit = limit !== null && Number.isSafeInteger(limit) && limit > 0;
  const {
    compact,
    dialogWidth,
    dialogHeight,
    visibleEntries,
    visibleHistory,
    selectedOverflow,
    historyStart,
  } = selectiveDialogLayout({
    width,
    height,
    nextItems,
    showModes,
    entries,
    history,
    historyIndex,
  });
  const actionLabel = action === "rollback" ? "Rollback" : "Run";

  useEffect(() => {
    if (inputReady && !focusedInitialInput.current) {
      focusedInitialInput.current = true;
      if (nextItems) {
        limitRef.current?.focus();
      } else {
        inputRef.current?.focus();
      }
    }
  }, [inputReady, nextItems]);

  useKeyboard((key) => {
    if (!inputReady || key.name === "escape" || inputRef.current?.focused) {
      onKeyDown(key);
    }
  });

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
          <Badge
            intent="neutral"
            label={nextItems ? "NEXT ITEMS" : "SOURCE IDS"}
          />
        </box>
        <DialogDescription
          content={
            target.kind === "migration"
              ? target.definitionId
              : `${target.groupId} · group`
          }
          wrapMode="word"
        />
        {showModes && (
          <Tabs
            flexShrink={0}
            marginTop={1}
            onValueChange={(value) => {
              if (value === "next-items" || value === "source-ids") {
                onModeChange(value);
              }
            }}
            value={mode}
          >
            <TabsList>
              <TabsTrigger label="Next items" value="next-items" />
              <TabsTrigger label="Source IDs" value="source-ids" />
            </TabsList>
          </Tabs>
        )}
        {nextItems ? (
          <box flexDirection="column" flexGrow={1} marginTop={1}>
            <text fg={colors.foreground}>Items per migration</text>
            <NumberField
              inputRef={limitRef}
              onSubmit={onConfirm}
              onValueChange={onLimitChange}
              placeholder="Enter a positive whole number"
              smallStep={1}
              value={limit}
              width="100%"
            />
            <text fg={colors.dim} marginTop={1} wrapMode="word">
              Process the next items that need work, in source order. Unchanged
              items don’t count. Failed or skipped attempts count toward the
              limit.
            </text>
            <text fg={colors.dim} marginTop={1} wrapMode="word">
              The limit applies to each migration, including dependencies.
            </text>
            {feedback && (
              <text
                fg={feedback.tone === "error" ? colors.danger : colors.dim}
                wrapMode="word"
              >
                {feedback.message}
              </text>
            )}
          </box>
        ) : (
          <>
            <box
              style={{ flexShrink: 0, height: 1, marginTop: compact ? 0 : 1 }}
            >
              <text fg={colors.foreground}>Source ID</text>
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
                placeholder="Enter source ID"
                placeholderColor={colors.dim}
                ref={inputRef}
                textColor={colors.foreground}
                value={draft}
                width="100%"
              />
            </box>
            <box style={{ flexShrink: 0, height: 1 }}>
              <text
                fg={feedback?.tone === "error" ? colors.danger : colors.dim}
              >
                {feedback?.message ?? "Press Enter to add."}
              </text>
            </box>
            <box
              style={{
                flexDirection: "row",
                flexShrink: 0,
                height: 1,
                justifyContent: "space-between",
                marginTop: compact ? 0 : 1,
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
                marginTop: compact ? 0 : 1,
              }}
            >
              <text fg={colors.foreground}>History</text>
              <text fg={colors.dim}>{countLabel(history.length, "item")}</text>
            </box>
            {historyLoading ? (
              <text fg={colors.dim}>Loading history…</text>
            ) : null}
            {!historyLoading && visibleHistory.length === 0 ? (
              <text fg={colors.dim}>No entries in history.</text>
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
          </>
        )}
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
            disabled={nextItems ? !validLimit : entries.length === 0}
            intent={action === "rollback" ? "warning" : "primary"}
            label={
              nextItems
                ? `↵ Run ${countLabel(limit ?? 0, "item")}`
                : `↵ ${actionLabel} ${countLabel(entries.length, "entry", "entries")}`
            }
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
            {nextItems
              ? "enter run · esc cancel"
              : "↑↓ history · space toggle · enter add/run · ctrl+⌫ remove"}
          </text>
        </box>
        {showModes && (
          <text fg={colors.dim}>tab focus · ←→ selection method</text>
        )}
      </DialogContent>
    </Dialog>
  );
};
