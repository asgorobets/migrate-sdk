import { SourceError } from "migrate-sdk";
import type { CommercetoolsSdkError } from "../../sdk.ts";

export const makeSourceError = (
  message: string,
  cause?: unknown
): SourceError =>
  new SourceError({
    ...(cause === undefined ? {} : { cause }),
    message,
  });

export const toSourceError = (cause: CommercetoolsSdkError): SourceError =>
  new SourceError({
    cause,
    message: cause.message,
  });

const hasStatusCode = (cause: unknown, statusCode: number): boolean => {
  if (typeof cause !== "object" || cause === null) {
    return false;
  }

  if ("statusCode" in cause && cause.statusCode === statusCode) {
    return true;
  }

  if ("code" in cause && cause.code === statusCode) {
    return true;
  }

  return (
    "body" in cause &&
    typeof cause.body === "object" &&
    cause.body !== null &&
    "statusCode" in cause.body &&
    cause.body.statusCode === statusCode
  );
};

export const isNotFoundSdkError = (cause: CommercetoolsSdkError): boolean =>
  hasStatusCode(cause.cause, 404);
