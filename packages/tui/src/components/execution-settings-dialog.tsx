/** @jsxImportSource @opentui/react */

import { type KeyEvent, RGBA } from "@opentui/core";
import { type RefObject, useEffect, useRef } from "react";
import { migrationColors as colors } from "./migration-dashboard.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Checkbox } from "./ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog.tsx";
import { NumberField, type NumberFieldInputRef } from "./ui/number-field.tsx";

export interface MigrationTuiExecutionSettingsDrafts {
  readonly process: number | null;
  readonly processUnbounded: boolean;
  readonly rollback: number | null;
  readonly rollbackUnbounded: boolean;
  readonly sourceInventoryScan: number | null;
}

type NumericConcurrencyField = "process" | "rollback" | "sourceInventoryScan";
type UnboundedConcurrencyField = "processUnbounded" | "rollbackUnbounded";

interface ExecutionSettingsDialogProps {
  readonly drafts: MigrationTuiExecutionSettingsDrafts;
  readonly height: number;
  readonly inputReady: boolean;
  readonly onCancel: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
  readonly onSave: () => void;
  readonly onUnboundedChange: (
    field: UnboundedConcurrencyField,
    checked: boolean
  ) => void;
  readonly onValueChange: (
    field: NumericConcurrencyField,
    value: number | null
  ) => void;
  readonly width: number;
}

interface PipelineConcurrencyFieldProps {
  readonly inputRef?: RefObject<NumberFieldInputRef | null>;
  readonly label: string;
  readonly onSave: () => void;
  readonly onUnboundedChange: (checked: boolean) => void;
  readonly onValueChange: (value: number | null) => void;
  readonly unbounded: boolean;
  readonly value: number | null;
  readonly width: number;
}

const PipelineConcurrencyField = (props: PipelineConcurrencyFieldProps) => (
  <box style={{ flexDirection: "column", flexShrink: 0, height: 4 }}>
    <text fg={colors.foreground}>{props.label}</text>
    <box style={{ flexDirection: "row", gap: 2, height: 3 }}>
      <NumberField
        {...(props.inputRef === undefined ? {} : { inputRef: props.inputRef })}
        min={1}
        onSubmit={props.onSave}
        onValueChange={props.onValueChange}
        readOnly={props.unbounded}
        smallStep={1}
        value={props.value}
        width={props.width}
      />
      <box style={{ alignItems: "center", flexDirection: "row", height: 3 }}>
        <Checkbox
          checked={props.unbounded}
          label="Unbounded"
          onCheckedChange={props.onUnboundedChange}
        />
      </box>
    </box>
  </box>
);

export const ExecutionSettingsDialog = ({
  drafts,
  height,
  inputReady,
  onCancel,
  onKeyDown,
  onSave,
  onUnboundedChange,
  onValueChange,
  width,
}: ExecutionSettingsDialogProps) => {
  const processRef = useRef<NumberFieldInputRef>(null);
  const compact = width < 72;
  const dialogWidth = Math.max(1, Math.min(68, width - (compact ? 4 : 8)));
  const dialogHeight = Math.max(1, Math.min(21, height - 2));
  const fieldWidth = compact ? 24 : 32;

  useEffect(() => {
    if (!inputReady) {
      return;
    }

    processRef.current?.focus();
  }, [inputReady]);

  const updateInteger = (
    field: NumericConcurrencyField,
    value: number | null
  ) => {
    if (value === null || (Number.isInteger(value) && value > 0)) {
      onValueChange(field, value);
    }
  };

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
          <DialogTitle content="Concurrency settings" />
          <Badge intent="neutral" label="SESSION" />
        </box>
        <box style={{ flexShrink: 0, height: 2 }}>
          <DialogDescription
            content="Control how many items run at once. Leave a value blank to use the configured default."
            wrapMode="word"
          />
        </box>
        <box style={{ flexShrink: 0, height: 1 }} />
        <PipelineConcurrencyField
          inputRef={processRef}
          label="Process Pipeline concurrency"
          onSave={onSave}
          onUnboundedChange={(checked) =>
            onUnboundedChange("processUnbounded", checked)
          }
          onValueChange={(value) => updateInteger("process", value)}
          unbounded={drafts.processUnbounded}
          value={drafts.process}
          width={fieldWidth}
        />
        <PipelineConcurrencyField
          label="Rollback Pipeline concurrency"
          onSave={onSave}
          onUnboundedChange={(checked) =>
            onUnboundedChange("rollbackUnbounded", checked)
          }
          onValueChange={(value) => updateInteger("rollback", value)}
          unbounded={drafts.rollbackUnbounded}
          value={drafts.rollback}
          width={fieldWidth}
        />
        <box style={{ flexDirection: "column", flexShrink: 0, height: 4 }}>
          <text fg={colors.foreground}>Source Inventory Scan concurrency</text>
          <NumberField
            min={1}
            onSubmit={onSave}
            onValueChange={(value) =>
              updateInteger("sourceInventoryScan", value)
            }
            smallStep={1}
            value={drafts.sourceInventoryScan}
            width={fieldWidth}
          />
        </box>
        <box style={{ flexShrink: 0, height: 1 }}>
          <text fg={colors.dim}>Changes apply to this TUI session.</text>
        </box>
        <box
          style={{
            flexDirection: "row-reverse",
            flexShrink: 0,
            gap: 1,
            height: 1,
          }}
        >
          <Button intent="primary" label="ctrl+s Save" onPress={onSave} />
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
            tab move · ↑↓ value · space toggle · ^s save · esc cancel
          </text>
        </box>
      </DialogContent>
    </Dialog>
  );
};
