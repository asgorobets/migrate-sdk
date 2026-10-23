import { RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { formatMigrateError } from "migrate-sdk/client/errors";
import type { MigrateDashboardRow } from "migrate-sdk/protocol";
import { useEffect, useRef, useState } from "react";
import type { MigrationTuiRuntime } from "../runtime.ts";
import { migrationColors as colors } from "./migration-dashboard.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
  useDialogNavigation,
} from "./ui/dialog.tsx";

/** Keep dashboard reads and observation unmounted until the store is usable. */
export const StoreSchemaSetup = ({
  runtime,
  onReady,
  onExit,
}: {
  readonly runtime: MigrationTuiRuntime;
  readonly onReady: (rows: readonly MigrateDashboardRow[]) => void;
  readonly onExit: () => void;
}) => {
  const { width, height } = useTerminalDimensions();
  const [plan, setPlan] = useState(runtime.storeSchema);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = plan === null || plan.status === "current";
  const canUpgrade =
    plan?.status === "upgrade-required" || plan?.status === "not-installed";

  let confirmLabel = current ? "Open dashboard" : "Check again";
  if (canUpgrade) {
    confirmLabel = "Upgrade store";
  }
  if (busy) {
    confirmLabel = "Please wait…";
  }
  let title = "Store schema needs attention";
  if (current) {
    title = "Store schema is up to date";
  } else if (canUpgrade) {
    title = "Store schema upgrade required";
  }

  const perform = async (upgrade: boolean) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const next =
        upgrade && canUpgrade && plan !== null
          ? await runtime.upgradeStoreSchema(plan.planId)
          : await runtime.getStoreSchema();
      if (!mounted.current) {
        return;
      }
      setPlan(next);
      if (next === null || next.status === "current") {
        onReady(runtime.rows);
      }
    } catch (cause) {
      if (!mounted.current) {
        return;
      }
      setError(formatMigrateError(cause));
      // A stale plan must be reviewed again before it can be applied.
      try {
        const updated = await runtime.getStoreSchema();
        if (mounted.current) {
          setPlan(updated);
        }
      } catch {
        // Preserve the original error and allow another connection attempt.
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
      }
    }
  };

  useDialogNavigation({
    enabled: open,
    disabled: busy,
    cancelDisabled: busy,
    onConfirm: () => {
      perform(canUpgrade);
    },
    onCancel: () => setOpen(false),
  });

  useKeyboard((key) => {
    if (key.ctrl || key.meta) {
      return;
    }
    if (key.name === "q" && !open && !busy) {
      key.preventDefault();
      key.stopPropagation();
      onExit();
    } else if (key.name === "u" && open && canUpgrade) {
      key.preventDefault();
      key.stopPropagation();
      perform(true);
    } else if (key.name === "r") {
      key.preventDefault();
      key.stopPropagation();
      if (open) {
        perform(false);
      } else {
        setOpen(true);
      }
    }
  });

  return (
    <box
      backgroundColor={colors.background}
      flexDirection="column"
      height="100%"
      padding={1}
      width="100%"
    >
      <text
        fg={colors.foreground}
      >{`Migrate · ${runtime.environmentLabel}`}</text>
      <text fg={colors.dim}>
        Connected. Update the store schema to open the dashboard.
      </text>
      {!open && (
        <box flexDirection="row" gap={1} marginTop={1}>
          <Button label="r Review schema" onPress={() => setOpen(true)} />
          <Button intent="neutral" label="q Quit" onPress={onExit} />
        </box>
      )}
      <Dialog
        onOpenChange={(next) => {
          if (!inFlight.current) {
            setOpen(next);
          }
        }}
        open={open}
      >
        <DialogContent
          backdropColor={RGBA.fromValues(0, 0, 0, 0.72)}
          backgroundColor={colors.surface}
          borderColor={colors.warning}
          focusedBorderColor={colors.warning}
          height={Math.max(1, Math.min(22, height - 4))}
          maxWidth={Math.max(1, Math.min(76, width - 4))}
          overflow="hidden"
          paddingX={1}
          width={Math.max(1, Math.min(76, width - 4))}
        >
          <box flexShrink={0} height={1}>
            <DialogTitle content={title} />
          </box>
          <box flexShrink={0} height={1}>
            <DialogDescription
              content={`Connected to ${runtime.environmentLabel}`}
            />
          </box>
          <scrollbox flexGrow={1} focused marginTop={1} minHeight={0}>
            {error !== null && <text fg={colors.danger}>{error}</text>}
            {plan !== null && (
              <box flexDirection="column" gap={1}>
                <text
                  fg={colors.foreground}
                >{`${plan.database} · ${plan.tablePrefix}`}</text>
                <text
                  fg={colors.foreground}
                >{`Schema ${plan.currentVersion === null ? "not installed" : `v${plan.currentVersion}`} → v${plan.targetVersion}`}</text>
                {canUpgrade && (
                  <text fg={colors.dim}>
                    Upgrade the migration store on the server to continue.
                  </text>
                )}
                {plan.pending.map((migration) => (
                  <text
                    fg={colors.foreground}
                    key={migration.id}
                  >{`v${migration.id}: ${migration.description}`}</text>
                ))}
                {!(canUpgrade || current) && (
                  <text fg={colors.warning}>
                    This schema cannot be upgraded automatically. Resolve the
                    issues below, then check again.
                  </text>
                )}
                {plan.issues.map((issue) => (
                  <text fg={colors.danger} key={issue}>
                    {issue}
                  </text>
                ))}
                {plan.warnings.map((warning) => (
                  <text fg={colors.warning} key={warning}>
                    {warning}
                  </text>
                ))}
              </box>
            )}
          </scrollbox>
          <DialogActions
            cancelDisabled={busy}
            disabled={busy}
            intent={canUpgrade ? "warning" : "primary"}
            label={confirmLabel}
            onCancel={() => setOpen(false)}
            onConfirm={() => {
              perform(canUpgrade);
            }}
          />
          <text fg={colors.dim} flexShrink={0}>
            {busy ? "Please wait…" : "↑↓ scroll · enter proceed · esc cancel"}
          </text>
        </DialogContent>
      </Dialog>
    </box>
  );
};
