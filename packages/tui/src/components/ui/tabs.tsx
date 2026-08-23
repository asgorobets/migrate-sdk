/** @jsxImportSource @opentui/react */

import { Tabs as TabsPrimitive } from "@tuiparts/react/tabs";
import { useTheme } from "./use-theme.tsx";

/** Props for the consumer-owned React Tabs Root. */
export type TabsProps = TabsPrimitive.Root.Props;
/** Props for the consumer-owned React Tabs List. */
export type TabsListProps = TabsPrimitive.List.Props;
/** Props for one labeled consumer-owned React Tabs Trigger. */
export interface TabsTriggerProps
  extends Omit<TabsPrimitive.Tab.Props, "children"> {
  label: string;
}
/** Props for one consumer-owned React Tabs Content region. */
export type TabsContentProps = TabsPrimitive.Panel.Props;

/** Consumer-owned React Tabs Root. */
export function Tabs({ orientation = "horizontal", ...props }: TabsProps) {
  return (
    <TabsPrimitive.Root
      flexDirection={orientation === "vertical" ? "row" : "column"}
      gap={0}
      orientation={orientation}
      {...props}
    />
  );
}

/** Consumer-owned React Tabs List layout. */
export function TabsList(props: TabsListProps) {
  const { orientation } = TabsPrimitive.useRootState();
  return (
    <TabsPrimitive.List
      flexDirection={orientation === "vertical" ? "column" : "row"}
      gap={2}
      {...props}
    />
  );
}

/** Consumer-owned labeled React Tabs Trigger presentation. */
export function TabsTrigger({ label, ...props }: TabsTriggerProps) {
  const tokens = useTheme();
  return (
    <TabsPrimitive.Tab {...props}>
      {(state) => {
        let foreground = tokens.colors.mutedForeground;

        if (state.disabled) {
          foreground = tokens.colors.disabledForeground;
        } else if (state.selected) {
          foreground = tokens.colors.focus;
        }

        return (
          <box
            backgroundColor={
              state.focused ? tokens.colors.surface : "transparent"
            }
          >
            <text
              content={state.selected ? `[ ${label} ]` : label}
              fg={foreground}
            />
          </box>
        );
      }}
    </TabsPrimitive.Tab>
  );
}

/** Consumer-owned React Tabs Content composition seam. */
export function TabsContent(props: TabsContentProps) {
  return <TabsPrimitive.Panel {...props} />;
}
