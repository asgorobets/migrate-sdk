/** @jsxImportSource @opentui/react */

import { Checkbox as CheckboxPrimitive } from "@tuiparts/react/checkbox";
import { useTheme } from "./use-theme.tsx";

export interface CheckboxProps
  extends Omit<CheckboxPrimitive.Root.Props, "children"> {
  label: string;
  /** One terminal-cell mark; widen the editable mark cell for wider content. */
  mark?: string;
  tone?: "accent" | "success";
}

/** Consumer-owned recipe installed on top of packaged primitive behavior. */
export function Checkbox({
  label,
  mark,
  tone = "accent",
  disabled,
  ...props
}: CheckboxProps) {
  const tokens = useTheme();
  const markColor =
    tone === "success" ? tokens.colors.success : tokens.colors.primary;

  return (
    <CheckboxPrimitive.Root
      backgroundColor="transparent"
      flexDirection="row"
      gap={1}
      {...(disabled === undefined ? {} : { disabled })}
      {...props}
    >
      {(state) => {
        let labelColor = tokens.colors.foreground;

        if (state.disabled) {
          labelColor = tokens.colors.disabledForeground;
        } else if (state.focused) {
          labelColor = tokens.colors.focus;
        }

        return (
          <>
            <box width={1}>
              <CheckboxPrimitive.Indicator>
                <text content={mark ?? tokens.glyphs.check} fg={markColor} />
              </CheckboxPrimitive.Indicator>
            </box>
            <text content={label} fg={labelColor} />
          </>
        );
      }}
    </CheckboxPrimitive.Root>
  );
}
