/** @jsxImportSource @opentui/react */

import { type KeyEvent, RGBA } from "@opentui/core";
import { Input } from "@tuiparts/react/input";
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

export interface SessionActivityExportDialogProps {
  readonly entryCount: number;
  readonly error?: string | undefined;
  readonly height: number;
  readonly inputReady: boolean;
  readonly onCancel: () => void;
  readonly onExport: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly onPathChange: (path: string) => void;
  readonly outputPath: string;
  readonly saving: boolean;
  readonly width: number;
}

export const SessionActivityExportDialog = ({
  entryCount,
  error,
  height,
  inputReady,
  onCancel,
  onExport,
  onKeyDown,
  onPathChange,
  outputPath,
  saving,
  width,
}: SessionActivityExportDialogProps) => {
  const inputRef = useRef<ElementRef<typeof Input>>(null);
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(76, width - (compact ? 8 : 4)));

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
        height={Math.max(1, Math.min(12, height - 4))}
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
          }}
        >
          <DialogTitle content="Export session activity" />
          <Badge intent="neutral" label="JSONL" />
        </box>
        <DialogDescription
          content={`${entryCount} retained ${entryCount === 1 ? "event" : "events"} · Existing files are not replaced.`}
          wrapMode="none"
        />
        <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
          <text fg={colors.foreground}>Output file</text>
        </box>
        <box
          style={{
            border: true,
            borderColor: error === undefined ? colors.info : colors.danger,
            flexDirection: "row",
            flexShrink: 0,
            height: 3,
            paddingX: 1,
            width: "100%",
          }}
        >
          <Input
            onInput={onPathChange}
            onSubmit={onExport}
            placeholder="migrate-activity.jsonl"
            placeholderColor={colors.dim}
            ref={inputRef}
            textColor={colors.foreground}
            value={outputPath}
            width="100%"
          />
        </box>
        <text
          content={
            error ?? "Relative paths are resolved from the current directory."
          }
          fg={error === undefined ? colors.dim : colors.danger}
          wrapMode="none"
        />
        <box
          style={{
            flexDirection: "row",
            flexShrink: 0,
            gap: 1,
            height: 1,
            justifyContent: "flex-end",
            marginTop: 1,
          }}
        >
          <Button intent="neutral" label="esc Cancel" onPress={onCancel} />
          <Button
            disabled={saving || outputPath.trim() === ""}
            intent="primary"
            label={saving ? "Exporting…" : "↵ Export"}
            onPress={onExport}
          />
        </box>
      </DialogContent>
    </Dialog>
  );
};
