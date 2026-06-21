import { SourceError } from "migrate-sdk";

export const jsonPlaceholderError = (
  message: string,
  cause?: unknown
): SourceError =>
  new SourceError(
    cause === undefined
      ? { message }
      : {
          cause,
          message,
        }
  );
