import { SourcePluginError } from "migrate-sdk";

export const jsonPlaceholderError = (
  message: string,
  cause?: unknown
): SourcePluginError =>
  new SourcePluginError(
    cause === undefined
      ? { message }
      : {
          cause,
          message,
        }
  );
