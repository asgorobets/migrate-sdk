import { DestinationPluginError } from "migrate-sdk";
import type { CommercetoolsSdkError } from "../../sdk.ts";

export const toDestinationPluginError = (
  cause: CommercetoolsSdkError
): DestinationPluginError =>
  new DestinationPluginError({
    cause,
    message: cause.message,
  });
