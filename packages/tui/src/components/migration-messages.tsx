import { useEffect } from "react";
import type { MigrationTuiMessage } from "../runtime.ts";

interface MigrationMessageColors {
  readonly dim: string;
  readonly foreground: string;
  readonly surface: string;
}

const messageMarker = (severity: MigrationTuiMessage["severity"]): string => {
  if (severity === "error") {
    return "✗";
  }
  if (severity === "warning") {
    return "!";
  }

  return "•";
};

const messageSourceLabel = (source: MigrationTuiMessage["source"]): string =>
  source === "diagnostic" ? "message" : source;

const MessageLine = ({
  colors,
  index,
  message,
  severityColor,
  showDefinitionId,
  total,
}: {
  readonly colors: MigrationMessageColors;
  readonly index: number;
  readonly message: MigrationTuiMessage;
  readonly severityColor: (severity: MigrationTuiMessage["severity"]) => string;
  readonly showDefinitionId: boolean;
  readonly total: number;
}) => {
  const hasDetails = message.details !== undefined;
  const definitionLabel = showDefinitionId ? `${message.definitionId} · ` : "";

  return (
    <box
      backgroundColor={colors.surface}
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
        content={`› ${index + 1}/${total} ${messageMarker(message.severity)} ${definitionLabel}Source identity ${message.identity} · ${messageSourceLabel(message.source)}${hasDetails ? " · details" : ""}`}
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
  readonly messages: readonly MigrationTuiMessage[];
  readonly onSelectedIndexChange: (index: number) => void;
  readonly selectedIndex: number;
  readonly severityColor: (severity: MigrationTuiMessage["severity"]) => string;
  readonly showDefinitionId?: boolean;
}) => {
  const selectedMessage = messages[selectedIndex];

  useEffect(() => {
    if (selectedIndex >= messages.length) {
      onSelectedIndexChange(Math.max(0, messages.length - 1));
    }
  }, [messages.length, onSelectedIndexChange, selectedIndex]);

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
      <box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          flexShrink: 1,
          minHeight: 0,
        }}
      >
        {loading ? <text fg={colors.dim}>Loading messages…</text> : null}
        {!loading && messages.length === 0 ? (
          <text fg={colors.dim}>No messages.</text>
        ) : null}
        {loading || selectedMessage === undefined ? null : (
          <MessageLine
            colors={colors}
            index={selectedIndex}
            key={`${selectedMessage.identity}-${selectedMessage.source}-${selectedMessage.updatedAt.toISOString()}-${selectedMessage.message}`}
            message={selectedMessage}
            severityColor={severityColor}
            showDefinitionId={showDefinitionId}
            total={messages.length}
          />
        )}
      </box>
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
