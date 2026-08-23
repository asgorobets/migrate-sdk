import { type KeyEvent, RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MigrationTuiMessage } from "../runtime.ts";
import {
  migrationColors as colors,
  migrationStatusColor,
} from "./migration-dashboard.tsx";
import { Badge, type BadgeIntent } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.tsx";

const severityIntent = (
  severity: MigrationTuiMessage["severity"]
): BadgeIntent => {
  if (severity === "error") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }

  return "neutral";
};

const messageSourceLabel = (source: MigrationTuiMessage["source"]): string =>
  source === "diagnostic" ? "message" : source;

export const MessageDetailDialog = ({
  height,
  index,
  message,
  onClose,
  showDefinitionId = false,
  total,
  width,
}: {
  readonly height: number;
  readonly index: number;
  readonly message: MigrationTuiMessage;
  readonly onClose: () => void;
  readonly showDefinitionId?: boolean;
  readonly total: number;
  readonly width: number;
}) => {
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(88, width - (compact ? 4 : 8)));
  const dialogHeight = Math.max(1, Math.min(28, height - 4));
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const [inputReady, setInputReady] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setInputReady(true), 100);
    return () => clearTimeout(timer);
  }, []);

  const handleKeyDown = useCallback(
    (key: KeyEvent) => {
      if (!inputReady && (key.name === "return" || key.name === "linefeed")) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }

      if (
        key.name === "escape" ||
        key.name === "return" ||
        key.name === "linefeed"
      ) {
        key.preventDefault();
        key.stopPropagation();
        onClose();
      } else if (key.name === "up" || key.name === "k") {
        key.preventDefault();
        key.stopPropagation();
        scrollboxRef.current?.scrollBy(-1, "step");
      } else if (key.name === "down" || key.name === "j") {
        key.preventDefault();
        key.stopPropagation();
        scrollboxRef.current?.scrollBy(1, "step");
      } else if (key.name === "pageup") {
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
    },
    [inputReady, onClose]
  );

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        backdropColor={RGBA.fromValues(0, 0, 0, 0.72)}
        backgroundColor={colors.surface}
        borderColor={migrationStatusColor(message.severity)}
        focusedBorderColor={migrationStatusColor(message.severity)}
        height={dialogHeight}
        maxWidth={dialogWidth}
        onKeyDown={handleKeyDown}
        overflow="hidden"
        paddingLeft={compact ? 1 : 2}
        paddingRight={compact ? 1 : 2}
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
          <DialogTitle content={`Message ${index + 1} of ${total}`} />
          <Badge
            intent={severityIntent(message.severity)}
            label={message.severity.toUpperCase()}
          />
        </box>
        <DialogDescription
          content={`${showDefinitionId ? `${message.definitionId} · ` : ""}Source identity ${message.identity} · ${messageSourceLabel(message.source)} · ${message.updatedAt.toLocaleString()}`}
          wrapMode="word"
        />
        <scrollbox
          focused={false}
          ref={scrollboxRef}
          scrollX={false}
          scrollY
          style={{
            flexGrow: 1,
            flexShrink: 1,
            marginTop: 1,
            minHeight: 0,
            width: "100%",
          }}
          verticalScrollbarOptions={{ visible: true }}
          viewportCulling
        >
          <text
            content={message.message}
            fg={colors.foreground}
            wrapMode="word"
          />
          {message.details === undefined ? null : (
            <>
              <box style={{ flexShrink: 0, height: 1, marginTop: 1 }}>
                <text fg={colors.dim}>Details</text>
              </box>
              <text content={message.details} fg={colors.dim} wrapMode="word" />
            </>
          )}
        </scrollbox>
        <box
          style={{
            alignItems: "center",
            flexDirection: "row",
            flexShrink: 0,
            height: 1,
            justifyContent: "space-between",
            marginTop: 1,
            width: "100%",
          }}
        >
          <text fg={colors.dim}>
            {compact
              ? "↑↓ scroll · PgUp/PgDn · esc close"
              : "↑↓/jk scroll · PgUp/PgDn jump · Home/End"}
          </text>
          <Button intent="neutral" label="↵ Close" onPress={onClose} />
        </box>
      </DialogContent>
    </Dialog>
  );
};
