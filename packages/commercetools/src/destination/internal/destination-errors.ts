import { DestinationError } from "migrate-sdk";
import type { CommercetoolsSdkError } from "../../sdk.ts";

export const toDestinationError = (
  cause: CommercetoolsSdkError
): DestinationError =>
  new DestinationError({
    cause,
    message: cause.message,
  });
