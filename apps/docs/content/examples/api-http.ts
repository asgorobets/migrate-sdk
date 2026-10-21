import { Effect } from "effect";
import { DestinationError, SourceError } from "migrate-sdk";

export interface ApiEndpoint {
  readonly token?: string;
  readonly url: string;
}

const trailingSlash = /\/$/;

const headers = (endpoint: ApiEndpoint) => ({
  "Content-Type": "application/json",
  ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
});

export const readJson = (endpoint: ApiEndpoint) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(endpoint.url, {
        headers: headers(endpoint),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourceError({ message: `Source HTTP ${response.status}` });
      }
      return (await response.json()) as unknown;
    },
    catch: (cause) =>
      cause instanceof SourceError
        ? cause
        : new SourceError({ message: "Could not read API", cause }),
  });

export const writeJson = (
  endpoint: ApiEndpoint,
  id: string,
  method: "PUT" | "DELETE",
  body?: unknown
) =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(
        `${endpoint.url.replace(trailingSlash, "")}/${encodeURIComponent(id)}`,
        {
          method,
          headers: headers(endpoint),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        }
      );
      await response.body?.cancel();
      // Repeating a delete is successful when the resource is already absent.
      if (method === "DELETE" && response.status === 404) {
        return;
      }
      if (!response.ok) {
        throw new DestinationError({
          message: `Destination ${method} HTTP ${response.status}`,
        });
      }
    },
    catch: (cause) =>
      cause instanceof DestinationError
        ? cause
        : new DestinationError({
            message: `Could not ${method} API record`,
            cause,
          }),
  });
