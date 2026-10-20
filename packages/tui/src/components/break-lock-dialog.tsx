import { type KeyEvent, RGBA } from "@opentui/core";
import type { MigrationDefinitionLock } from "migrate-sdk";
import { migrationColors as colors } from "./migration-dashboard.tsx";
import { Badge } from "./ui/badge.tsx";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
  useDialogNavigation,
} from "./ui/dialog.tsx";

export const BreakLockDialog = ({
  height,
  lock,
  onCancel,
  onConfirm,
  onKeyDown,
  width,
}: {
  readonly height: number;
  readonly lock: MigrationDefinitionLock;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly width: number;
}) => {
  const compact = width < 80;
  const dialogWidth = Math.max(1, Math.min(72, width - (compact ? 8 : 4)));
  const dialogHeight = Math.max(1, Math.min(15, height - 4));
  const createdAt = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(lock.createdAt);

  useDialogNavigation({
    onConfirm,
    onCancel,
    onShortcut: (key) => {
      if (key.name === "y") {
        onKeyDown(key);
      }
    },
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
        borderColor={colors.danger}
        focusedBorderColor={colors.danger}
        height={dialogHeight}
        maxWidth={dialogWidth}
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
          <DialogTitle content="Break migration lock" />
          <Badge intent="danger" label="DESTRUCTIVE" />
        </box>
        <DialogDescription
          content={`${lock.definitionId} · This removes the persisted execution lock.`}
          wrapMode="none"
        />
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
          <text
            content={`Owner run  ${lock.ownerRunId}`}
            fg={colors.foreground}
            wrapMode="none"
          />
          <text
            content={`Created    ${createdAt}`}
            fg={colors.dim}
            wrapMode="none"
          />
          <text
            content={`Token      ${lock.token}`}
            fg={colors.dim}
            wrapMode="none"
          />
        </box>
        <box style={{ flexShrink: 0, marginTop: 1 }}>
          <text fg={colors.danger}>
            Only break this lock after confirming its owner is no longer
            running.
          </text>
        </box>
        <box style={{ flexGrow: 1, minHeight: 0 }} />
        <DialogActions
          intent="warning"
          label="Break lock"
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
        <text fg={colors.dim} flexShrink={0}>
          enter/y confirm · esc/n cancel
        </text>
      </DialogContent>
    </Dialog>
  );
};
