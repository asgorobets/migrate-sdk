import type { ScrollBoxRenderable } from "@opentui/core";
import type { MigrationMessage } from "migrate-sdk";
import { useEffect, useRef } from "react";
import {
  migrationMessageKindLabel,
  migrationMessageMarker,
  migrationMessageRowKey,
} from "./migration-message.ts";

interface MigrationMessageColors {
  readonly dim: string;
  readonly foreground: string;
  readonly selected: string;
  readonly surface: string;
}

const MessageLine = ({
  colors,
  index,
  message,
  selected,
  severityColor,
  showDefinitionId,
  total,
}: {
  readonly colors: MigrationMessageColors;
  readonly index: number;
  readonly message: MigrationMessage;
  readonly selected: boolean;
  readonly severityColor: (severity: MigrationMessage["severity"]) => string;
  readonly showDefinitionId: boolean;
  readonly total: number;
}) => {
  const hasDetails = message.details !== undefined;
  const definitionLabel = showDefinitionId ? `${message.definitionId} · ` : "";

  return (
    <box
      backgroundColor={selected ? colors.selected : colors.surface}
      id={`message-row-${index}`}
      style={{
        flexDirection: "column",
        flexShrink: 0,
        height: 2,
        paddingX: 1,
        width: "100%",
      }}
    >
      <text
        content={`${selected ? "›" : " "} ${index + 1}/${total} ${migrationMessageMarker(message.severity)} ${definitionLabel}Source identity ${message.sourceIdentity} · ${migrationMessageKindLabel(message.kind)}${hasDetails ? " · details" : ""}`}
        fg={severityColor(message.severity)}
        wrapMode="none"
      />
      <text content={message.message} fg={colors.foreground} wrapMode="none" />
    </box>
  );
};

export const MigrationMessages = ({
  colors,
  compact,
  loading,
  messages,
  onSelectedIndexChange,
  selectedIndex,
  severityColor,
  showDefinitionId = false,
}: {
  readonly colors: MigrationMessageColors;
  readonly compact: boolean;
  readonly loading: boolean;
  readonly messages: readonly MigrationMessage[];
  readonly onSelectedIndexChange: (index: number) => void;
  readonly selectedIndex: number;
  readonly severityColor: (severity: MigrationMessage["severity"]) => string;
  readonly showDefinitionId?: boolean;
}) => {
  const scrollboxRef = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    if (selectedIndex >= messages.length) {
      onSelectedIndexChange(Math.max(0, messages.length - 1));
    }
  }, [messages.length, onSelectedIndexChange, selectedIndex]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }

    const revealSelectedMessage = () => {
      const scrollbox = scrollboxRef.current;
      if (scrollbox === null || scrollbox.viewport.height === 0) {
        return;
      }

      const rowTop = selectedIndex * 2;
      const rowBottom = rowTop + 2;
      const viewportTop = scrollbox.scrollTop;
      const viewportBottom = viewportTop + scrollbox.viewport.height;

      if (rowTop < viewportTop) {
        scrollbox.scrollTo(rowTop);
      } else if (rowBottom > viewportBottom) {
        scrollbox.scrollTo(Math.max(0, rowBottom - scrollbox.viewport.height));
      }
    };
    revealSelectedMessage();
    const timeouts = [0, 16, 50].map((delay) =>
      setTimeout(revealSelectedMessage, delay)
    );

    return () => {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
    };
  }, [messages.length, selectedIndex]);

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        flexShrink: 1,
        minHeight: 0,
        marginTop: 1,
      }}
    >
      <scrollbox
        focused={false}
        ref={scrollboxRef}
        scrollX={false}
        scrollY
        style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }}
        verticalScrollbarOptions={{ visible: false }}
        viewportCulling
      >
        {loading ? <text fg={colors.dim}>Loading messages…</text> : null}
        {!loading && messages.length === 0 ? (
          <text fg={colors.dim}>No messages.</text>
        ) : null}
        {loading
          ? null
          : messages.map((message, index) => (
              <MessageLine
                colors={colors}
                index={index}
                key={migrationMessageRowKey(message)}
                message={message}
                selected={index === selectedIndex}
                severityColor={severityColor}
                showDefinitionId={showDefinitionId}
                total={messages.length}
              />
            ))}
      </scrollbox>
      {loading || messages.length === 0 ? null : (
        <box
          style={{
            flexDirection: "column",
            flexShrink: 0,
            height: compact ? 1 : 2,
            marginTop: 1,
          }}
        >
          {compact ? (
            <text
              content={`${selectedIndex + 1}/${messages.length} · ↑↓ move · ↵ expand · esc back`}
              fg={colors.dim}
              wrapMode="none"
            />
          ) : (
            <>
              <text
                content={`Message ${selectedIndex + 1} of ${messages.length} · ↵ expand · esc back`}
                fg={colors.dim}
                wrapMode="none"
              />
              <text
                content="↑↓/jk move · PgUp/PgDn jump · Home/End"
                fg={colors.dim}
                wrapMode="none"
              />
            </>
          )}
        </box>
      )}
    </box>
  );
};
