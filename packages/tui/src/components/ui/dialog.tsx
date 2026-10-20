/** @jsxImportSource @opentui/react */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Dialog as DialogPrimitive } from "@tuiparts/react/dialog";
import { useEffect, useRef } from "react";
import { Button } from "./button.tsx";
import { tint } from "./theme.ts";
import { useTheme } from "./use-theme.tsx";

/** Props for the consumer-owned Dialog root. */
export interface DialogProps extends DialogPrimitive.Root.Props {}

/** Props for the styled Dialog content composition. */
export interface DialogContentProps extends DialogPrimitive.Popup.Props {
  backdropColor?: DialogPrimitive.Backdrop.Props["backgroundColor"];
}

/** Consumer-owned wrapper over the packaged Dialog root. */
export function Dialog(props: DialogProps) {
  return <DialogPrimitive.Root {...props} />;
}

/** Editable trigger presentation that retains the primitive Trigger ref. */
export function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  const tokens = useTheme();
  return (
    <DialogPrimitive.Trigger
      backgroundColor={tokens.colors.surface}
      paddingLeft={tokens.density.paddingX}
      paddingRight={tokens.density.paddingX}
      {...props}
    />
  );
}

/** Responsive Portal, Backdrop, and Popup composition for Dialog content. */
export function DialogContent({
  backdropColor,
  children,
  ...props
}: DialogContentProps) {
  const tokens = useTheme();
  return (
    <DialogPrimitive.Portal
      alignItems="center"
      height="100%"
      justifyContent="center"
      position="absolute"
      width="100%"
    >
      <DialogPrimitive.Backdrop
        backgroundColor={
          backdropColor ??
          tint(tokens.colors.background, tokens.colors.foreground, 0.25)
        }
        height="100%"
        position="absolute"
        width="100%"
      />
      <DialogPrimitive.Popup
        backgroundColor={tokens.colors.surface}
        border
        borderColor={tokens.colors.border}
        borderStyle={tokens.borders.style}
        flexDirection="column"
        maxWidth={56}
        paddingLeft={tokens.density.paddingX}
        paddingRight={tokens.density.paddingX}
        width="80%"
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

/** Editable semantic Dialog title. */
export function DialogTitle(props: DialogPrimitive.Title.Props) {
  const tokens = useTheme();
  return <DialogPrimitive.Title fg={tokens.colors.foreground} {...props} />;
}

/** Editable semantic Dialog description. */
export function DialogDescription(props: DialogPrimitive.Description.Props) {
  const tokens = useTheme();
  return (
    <DialogPrimitive.Description
      fg={tokens.colors.mutedForeground}
      {...props}
    />
  );
}

/** Editable Dialog dismissal or action control. */
export function DialogClose(props: DialogPrimitive.Close.Props) {
  const tokens = useTheme();
  return (
    <DialogPrimitive.Close
      backgroundColor={tokens.colors.surface}
      paddingLeft={tokens.density.paddingX}
      paddingRight={tokens.density.paddingX}
      {...props}
    />
  );
}

export interface DialogChoice {
  readonly disabled?: boolean;
  readonly value: string;
}

const nextDialogChoice = (
  choices: readonly DialogChoice[],
  value: string | undefined,
  step: number
) => {
  const available = choices.filter((choice) => !choice.disabled);
  const index = available.findIndex((choice) => choice.value === value);
  return available[(index + step + available.length) % available.length]?.value;
};

/** Shared keyboard contract for confirmation and choice dialogs.
 * Forms keep their own field navigation; text previews use Page Up/Down.
 */
export function useDialogNavigation({
  enabled = true,
  disabled = false,
  navigationDisabled = false,
  cancelDisabled = false,
  choices = [],
  value,
  onValueChange,
  onConfirm,
  onCancel,
  onShortcut,
  resetKey,
}: {
  readonly navigationDisabled?: boolean;
  readonly enabled?: boolean;
  readonly disabled?: boolean;
  readonly cancelDisabled?: boolean;
  readonly choices?: readonly DialogChoice[];
  readonly value?: string;
  readonly onValueChange?: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onShortcut?: (key: KeyEvent) => void;
  readonly resetKey?: string;
}) {
  const renderer = useRenderer();
  const ready = useRef<string | null>(null);
  const inputPhase = `${enabled}:${resetKey ?? ""}`;
  useEffect(() => {
    ready.current = null;
    const timer = setTimeout(() => {
      ready.current = inputPhase;
    }, 100);
    return () => clearTimeout(timer);
  }, [inputPhase]);

  const cancelDialog = () => {
    if (!cancelDisabled) {
      onCancel();
    }
  };

  useKeyboard((key) => {
    if (!enabled || key.ctrl || key.meta) {
      return;
    }
    const enter = key.name === "return" || key.name === "linefeed";
    const cancel = key.name === "escape" || key.name === "n";
    const navigate =
      choices.length > 0 && (key.name === "up" || key.name === "down");
    if (!(enter || cancel || navigate)) {
      onShortcut?.(key);
      return;
    }
    key.preventDefault();
    key.stopPropagation();
    if (cancel) {
      cancelDialog();
      return;
    }
    if (enter) {
      if (ready.current !== inputPhase) {
        return;
      }
      if (renderer.currentFocusedRenderable?.id === "dialog-cancel") {
        cancelDialog();
      } else if (!disabled) {
        onConfirm();
      }
      return;
    }
    if (navigationDisabled) {
      return;
    }
    const next = nextDialogChoice(choices, value, key.name === "up" ? -1 : 1);
    if (next !== undefined) {
      onValueChange?.(next);
    }
  });
}

/** Consistent primary action and Escape cancellation for dialog footers. */
export function DialogActions({
  label,
  onConfirm,
  onCancel,
  disabled,
  cancelDisabled,
  intent = "primary",
  marginTop = 1,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly disabled?: boolean;
  readonly cancelDisabled?: boolean;
  readonly intent?: "primary" | "warning";
  readonly marginTop?: number;
}) {
  return (
    <box
      flexDirection="row-reverse"
      flexShrink={0}
      gap={1}
      height={1}
      marginTop={marginTop}
    >
      <Button
        {...(disabled === undefined ? {} : { disabled })}
        intent={intent}
        label={`↵ ${label}`}
        onPress={onConfirm}
      />
      <Button
        id="dialog-cancel"
        {...(cancelDisabled === undefined ? {} : { disabled: cancelDisabled })}
        intent="neutral"
        label="esc Cancel"
        onPress={onCancel}
      />
    </box>
  );
}
