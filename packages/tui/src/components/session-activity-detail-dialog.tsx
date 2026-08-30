/** @jsxImportSource @opentui/react */

import { type KeyEvent, RGBA, type ScrollBoxRenderable } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionActivityEntry } from "../session-activity.ts";
import { migrationColors as colors } from "./migration-dashboard.tsx";
import { sessionActivityKindPresentation } from "./session-activity.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.tsx";

export const SessionActivityDetailDialog = ({
  entry,
  height,
  onClose,
  width,
}: {
  readonly entry: SessionActivityEntry;
  readonly height: number;
  readonly onClose: () => void;
  readonly width: number;
}) => {
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(88, width - (compact ? 4 : 8)));
  const dialogHeight = Math.max(1, Math.min(28, height - 4));
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);
  const [inputReady, setInputReady] = useState(false);
  const presentation = sessionActivityKindPresentation(entry.kind);

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
        borderColor={presentation.color}
        focusedBorderColor={presentation.color}
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
          <DialogTitle content={`Event ${entry.sequence}`} />
          <Badge intent={presentation.intent} label={presentation.label} />
        </box>
        <DialogDescription
          content={entry.occurredAt.toLocaleString()}
          wrapMode="none"
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
            content={entry.message}
            fg={colors.foreground}
            wrapMode="word"
          />
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
