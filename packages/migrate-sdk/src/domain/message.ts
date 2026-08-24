import { Schema } from "effect";
import {
  EncodedSourceIdentity,
  MigrationDefinitionId,
  MigrationRunId,
} from "./ids.ts";
import {
  MigrationItemErrorDetail,
  MigrationItemErrorKind,
  type MigrationItemState,
} from "./state.ts";

export const MigrationMessageKind = Schema.Literals([
  "item-error",
  "skip-reason",
  "update-reason",
  "process-diagnostic",
  "rollback-error",
  "rollback-diagnostic",
]);
export type MigrationMessageKind = typeof MigrationMessageKind.Type;

export const MigrationMessageSeverity = Schema.Literals([
  "info",
  "warning",
  "error",
]);
export type MigrationMessageSeverity = typeof MigrationMessageSeverity.Type;

const MigrationMessageBaseFields = {
  definitionId: MigrationDefinitionId,
  message: Schema.String,
  runId: MigrationRunId,
  sourceIdentity: EncodedSourceIdentity,
  updatedAt: Schema.DateFromString,
} as const;

const ForbiddenErrorMessageFields = {
  errorKind: Schema.optional(Schema.Never),
  errorTag: Schema.optional(Schema.Never),
} as const;

const ForbiddenSequenceMessageField = {
  sequence: Schema.optional(Schema.Never),
} as const;

const MigrationErrorMessageFields = {
  ...MigrationMessageBaseFields,
  details: Schema.optional(Schema.Array(MigrationItemErrorDetail)),
  errorKind: MigrationItemErrorKind,
  errorTag: Schema.String,
  ...ForbiddenSequenceMessageField,
  severity: Schema.Literal("error"),
} as const;

const MigrationDiagnosticMessageFields = {
  ...MigrationMessageBaseFields,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  ...ForbiddenErrorMessageFields,
  sequence: Schema.Int,
  severity: MigrationMessageSeverity,
} as const;

const MigrationReasonMessageFields = {
  ...MigrationMessageBaseFields,
  details: Schema.optional(Schema.Never),
  ...ForbiddenErrorMessageFields,
  ...ForbiddenSequenceMessageField,
} as const;

export const MigrationItemErrorMessage = Schema.Struct({
  ...MigrationErrorMessageFields,
  kind: Schema.Literal("item-error"),
});
export type MigrationItemErrorMessage = typeof MigrationItemErrorMessage.Type;

export const MigrationSkipReasonMessage = Schema.Struct({
  ...MigrationReasonMessageFields,
  kind: Schema.Literal("skip-reason"),
  severity: Schema.Literal("info"),
});
export type MigrationSkipReasonMessage = typeof MigrationSkipReasonMessage.Type;

export const MigrationUpdateReasonMessage = Schema.Struct({
  ...MigrationReasonMessageFields,
  kind: Schema.Literal("update-reason"),
  severity: Schema.Literal("warning"),
});
export type MigrationUpdateReasonMessage =
  typeof MigrationUpdateReasonMessage.Type;

export const MigrationProcessDiagnosticMessage = Schema.Struct({
  ...MigrationDiagnosticMessageFields,
  kind: Schema.Literal("process-diagnostic"),
});
export type MigrationProcessDiagnosticMessage =
  typeof MigrationProcessDiagnosticMessage.Type;

export const MigrationRollbackErrorMessage = Schema.Struct({
  ...MigrationErrorMessageFields,
  kind: Schema.Literal("rollback-error"),
});
export type MigrationRollbackErrorMessage =
  typeof MigrationRollbackErrorMessage.Type;

export const MigrationRollbackDiagnosticMessage = Schema.Struct({
  ...MigrationDiagnosticMessageFields,
  kind: Schema.Literal("rollback-diagnostic"),
});
export type MigrationRollbackDiagnosticMessage =
  typeof MigrationRollbackDiagnosticMessage.Type;

export const MigrationMessage = Schema.Union([
  MigrationItemErrorMessage,
  MigrationSkipReasonMessage,
  MigrationUpdateReasonMessage,
  MigrationProcessDiagnosticMessage,
  MigrationRollbackErrorMessage,
  MigrationRollbackDiagnosticMessage,
]);
export type MigrationMessage = typeof MigrationMessage.Type;

const errorMessage = (error: {
  readonly errorTag: string;
  readonly message: string;
}): string => `${error.errorTag}: ${error.message}`;

const errorDetails = (
  details: readonly MigrationItemErrorDetail[]
): readonly MigrationItemErrorDetail[] =>
  details.map((detail) => ({
    message: detail.message,
    ...(detail.path === undefined ? {} : { path: detail.path }),
  }));

export const migrationMessagesFromItemState = (
  state: MigrationItemState
): readonly MigrationMessage[] => {
  const messages: MigrationMessage[] = [];
  const sourceIdentity = state.sourceIdentity.encoded;

  if (state.status === "failed") {
    messages.push({
      definitionId: state.definitionId,
      ...(state.error.details === undefined
        ? {}
        : { details: errorDetails(state.error.details) }),
      errorKind: state.error.kind,
      errorTag: state.error.errorTag,
      kind: "item-error",
      message: errorMessage(state.error),
      runId: state.lastRunId,
      severity: "error",
      sourceIdentity,
      updatedAt: state.updatedAt,
    });
  } else if (state.status === "skipped") {
    messages.push({
      definitionId: state.definitionId,
      kind: "skip-reason",
      message: state.skipReason,
      runId: state.lastRunId,
      severity: "info",
      sourceIdentity,
      updatedAt: state.updatedAt,
    });
  } else if (state.status === "needs-update") {
    messages.push({
      definitionId: state.definitionId,
      kind: "update-reason",
      message: state.reason,
      runId: state.lastRunId,
      severity: "warning",
      sourceIdentity,
      updatedAt: state.updatedAt,
    });
  }

  for (const entry of state.journal?.process.entries ?? []) {
    if (entry.kind !== "diagnostic") {
      continue;
    }

    messages.push({
      definitionId: state.definitionId,
      ...(entry.details === undefined ? {} : { details: entry.details }),
      kind: "process-diagnostic",
      message: entry.message,
      runId: state.journal?.process.runId ?? state.lastRunId,
      sequence: entry.sequence,
      severity: entry.severity,
      sourceIdentity,
      updatedAt: state.updatedAt,
    });
  }

  for (const attempt of state.journal?.rollbackAttempts ?? []) {
    messages.push({
      definitionId: state.definitionId,
      ...(attempt.error.details === undefined
        ? {}
        : { details: errorDetails(attempt.error.details) }),
      errorKind: attempt.error.kind,
      errorTag: attempt.error.errorTag,
      kind: "rollback-error",
      message: errorMessage(attempt.error),
      runId: attempt.runId,
      severity: "error",
      sourceIdentity,
      updatedAt: attempt.failedAt,
    });

    for (const entry of attempt.entries) {
      if (entry.kind !== "diagnostic") {
        continue;
      }

      messages.push({
        definitionId: state.definitionId,
        ...(entry.details === undefined ? {} : { details: entry.details }),
        kind: "rollback-diagnostic",
        message: entry.message,
        runId: attempt.runId,
        sequence: entry.sequence,
        severity: entry.severity,
        sourceIdentity,
        updatedAt: attempt.failedAt,
      });
    }
  }

  return messages;
};
