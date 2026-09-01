import { Option } from "effect";
import { HttpClientError } from "effect/unstable/http";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";

export const rpcClientHttpStatusCode = (
  error: RpcClientError
): Option.Option<number> => {
  if (
    error.reason._tag !== "HttpError" ||
    error.reason.kind !== "StatusCodeError"
  ) {
    return Option.none();
  }

  return error.reason.cause instanceof HttpClientError.StatusCodeError
    ? Option.some(error.reason.cause.response.status)
    : Option.none();
};
