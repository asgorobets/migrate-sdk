/** @jsxImportSource @opentui/react */

import { Button as ButtonPrimitive } from "@tuiparts/react/button";
import { type Tokens, tint } from "./theme.ts";
import { useTheme } from "./use-theme.tsx";

export interface ButtonProps extends Omit<ButtonPrimitive.Props, "children"> {
  intent?: "neutral" | "primary" | "warning";
  label: string;
  size?: "compact" | "comfortable";
}

const buttonBackground = (
  state: ButtonPrimitive.State,
  intent: NonNullable<ButtonProps["intent"]>,
  colors: Tokens["colors"]
) => {
  if (state.disabled) {
    return colors.disabled;
  }
  if (state.pressed) {
    return tint(colors.focus, colors.foreground, 0.3);
  }
  if (state.focused) {
    return colors.focus;
  }

  if (intent === "primary") {
    return colors.primary;
  }
  if (intent === "warning") {
    return colors.warning;
  }

  return colors.surface;
};

const buttonForeground = (
  state: ButtonPrimitive.State,
  intent: NonNullable<ButtonProps["intent"]>,
  colors: Tokens["colors"]
) => {
  if (state.disabled) {
    return colors.disabledForeground;
  }

  if (intent === "primary") {
    return colors.primaryForeground;
  }
  if (intent === "warning") {
    return colors.warningForeground;
  }

  return colors.foreground;
};

/** Consumer-owned React recipe installed on packaged Button behavior. */
export function Button({
  intent = "primary",
  label,
  size = "compact",
  disabled,
  ...props
}: ButtonProps) {
  const tokens = useTheme();
  return (
    <ButtonPrimitive
      backgroundColor="transparent"
      {...(disabled === undefined ? {} : { disabled })}
      {...props}
    >
      {(state) => (
        <box
          backgroundColor={buttonBackground(state, intent, tokens.colors)}
          paddingX={
            size === "comfortable"
              ? tokens.density.comfortablePaddingX
              : tokens.density.paddingX
          }
        >
          <text
            content={label}
            fg={buttonForeground(state, intent, tokens.colors)}
          />
        </box>
      )}
    </ButtonPrimitive>
  );
}
