import type { MigrationTuiMessage } from "../runtime.ts";

export const migrationMessageKindLabel = (
  kind: MigrationTuiMessage["kind"]
): string => {
  switch (kind) {
    case "process-diagnostic":
      return "message";
    case "rollback-diagnostic":
    case "rollback-error":
      return "rollback";
    case "item-error":
    case "skip-reason":
    case "update-reason":
      return "item";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

export const migrationMessageDetailsText = (
  details: Exclude<MigrationTuiMessage["details"], undefined>
): string => JSON.stringify(details, null, 2) ?? String(details);

export const migrationMessageMarker = (
  severity: MigrationTuiMessage["severity"]
): string => {
  if (severity === "error") {
    return "✗";
  }
  if (severity === "warning") {
    return "!";
  }

  return "•";
};

export const migrationMessageRowKey = (message: MigrationTuiMessage): string =>
  JSON.stringify([
    message.definitionId,
    message.sourceIdentity,
    message.kind,
    message.runId,
    "sequence" in message ? message.sequence : "state",
    message.updatedAt.toISOString(),
    message.message,
  ]);
