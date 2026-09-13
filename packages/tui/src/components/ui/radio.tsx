/** @jsxImportSource @opentui/react */

import { Radio as RadioPrimitive } from "@tuiparts/react/radio";
import type { Tokens } from "./theme.ts";
import { useTheme } from "./use-theme.tsx";

interface RadioProps extends Omit<RadioPrimitive.Root.Props, "children"> {
  readonly accentColor?: Tokens["colors"]["focus"];
  readonly label: string;
}

export function Radio({ accentColor, label, ...props }: RadioProps) {
  const tokens = useTheme();
  return (
    <RadioPrimitive.Root flexShrink={0} height={1} {...props}>
      {(state) => {
        let foreground = tokens.colors.foreground;
        if (state.disabled) {
          foreground = tokens.colors.disabledForeground;
        } else if (state.checked || state.focused) {
          foreground = accentColor ?? tokens.colors.focus;
        }
        return (
          <text
            content={`${state.checked ? "●" : "○"} ${label}`}
            fg={foreground}
          />
        );
      }}
    </RadioPrimitive.Root>
  );
}
