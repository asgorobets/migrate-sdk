import type { Schema, SchemaIssue } from "effect";
import type {
  MigrationItemError,
  MigrationItemErrorDetail,
  MigrationItemErrorKind,
} from "../domain/state.ts";

const errorTag = (error: unknown, fallback: string): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
  ) {
    return error._tag;
  }

  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }

  return fallback;
};

const errorMessage = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.length > 0
  ) {
    return error.message;
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
};

export const normalizeItemError = (
  kind: MigrationItemErrorKind,
  error: unknown
): MigrationItemError => ({
  kind,
  errorTag: errorTag(error, `${kind}-error`),
  message: errorMessage(error),
});

export const sourcePayloadSchemaErrorTag = "SourcePayloadSchemaError";

const maxSchemaErrorDetails = 5;

const pathSegment = (segment: PropertyKey): string => String(segment);

const pathString = (path: readonly PropertyKey[]): string | undefined =>
  path.length === 0 ? undefined : path.map(pathSegment).join(".");

const collectSchemaErrorDetails = (
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[],
  details: MigrationItemErrorDetail[]
): number => {
  switch (issue._tag) {
    case "Pointer": {
      return collectSchemaErrorDetails(
        issue.issue,
        [...path, ...issue.path],
        details
      );
    }
    case "Composite": {
      let count = 0;

      for (const child of issue.issues) {
        count += collectSchemaErrorDetails(child, path, details);
      }

      return count;
    }
    case "AnyOf": {
      if (issue.issues.length === 0) {
        break;
      }

      let count = 0;

      for (const child of issue.issues) {
        count += collectSchemaErrorDetails(child, path, details);
      }

      return count;
    }
    case "Encoding":
    case "Filter": {
      return collectSchemaErrorDetails(issue.issue, path, details);
    }
  }

  if (details.length < maxSchemaErrorDetails) {
    const detailPath = pathString(path);

    details.push({
      ...(detailPath === undefined ? {} : { path: detailPath }),
      message: String(issue),
    });
  }

  return 1;
};

const schemaErrorDetails = (
  error: Schema.SchemaError
): readonly MigrationItemErrorDetail[] => {
  const details: MigrationItemErrorDetail[] = [];
  const issueCount = collectSchemaErrorDetails(error.issue, [], details);
  const omittedCount = issueCount - details.length;

  if (omittedCount > 0) {
    details.push({
      message: `${omittedCount} additional schema issue(s) omitted`,
    });
  }

  return details.length === 0 ? [{ message: error.message }] : details;
};

export const normalizeSourcePayloadSchemaError = (
  error: Schema.SchemaError
): MigrationItemError => ({
  kind: "source",
  errorTag: sourcePayloadSchemaErrorTag,
  message: "Source payload did not match Source Payload Schema",
  details: schemaErrorDetails(error),
});
