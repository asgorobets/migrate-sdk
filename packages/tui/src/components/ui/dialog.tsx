/** @jsxImportSource @opentui/react */

import { Dialog as DialogPrimitive } from "@tuiparts/react/dialog";
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
