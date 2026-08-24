/** @jsxImportSource @opentui/react */

import { NumberField as NumberFieldPrimitive } from "@tuiparts/react/number-field";
import type { ElementRef, Ref } from "react";
import { useTheme } from "./use-theme.tsx";

export type NumberFieldInputRef = ElementRef<typeof NumberFieldPrimitive.Input>;

export interface NumberFieldProps
  extends Omit<NumberFieldPrimitive.Root.Props, "children"> {
  readonly inputRef?: Ref<NumberFieldInputRef>;
  readonly onSubmit?: () => void;
  readonly placeholder?: string;
}

/** Consumer-owned numeric input recipe built on packaged Number Field behavior. */
export function NumberField({
  inputRef,
  onSubmit,
  placeholder = "configured default",
  readOnly,
  ...props
}: NumberFieldProps) {
  const tokens = useTheme();

  return (
    <NumberFieldPrimitive.Root
      height={3}
      {...(readOnly === undefined ? {} : { readOnly })}
      {...props}
    >
      {(state) => {
        const valueColor = state.readOnly
          ? tokens.colors.disabledForeground
          : tokens.colors.foreground;

        return (
          <box
            border
            borderColor={
              state.focused ? tokens.colors.focus : tokens.colors.border
            }
            flexGrow={1}
            height={3}
            paddingX={1}
          >
            <NumberFieldPrimitive.Input
              cursorColor={tokens.colors.focus}
              onSubmit={() => onSubmit?.()}
              placeholder={placeholder}
              placeholderColor={tokens.colors.disabledForeground}
              {...(inputRef === undefined ? {} : { ref: inputRef })}
              textColor={valueColor}
              width="100%"
            />
          </box>
        );
      }}
    </NumberFieldPrimitive.Root>
  );
}
