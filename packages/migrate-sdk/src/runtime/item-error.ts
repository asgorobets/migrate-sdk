import type {
  MigrationItemError,
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
  cause: error,
});
