import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { MigrateConnection } from "./connection.ts";
import { connectMigrateHttpServer } from "./internal/http-connection.ts";

export interface BrowserMigrateConnectionInput {
  readonly bearerToken?: string | undefined;
  readonly credentials?: RequestCredentials | undefined;
  readonly fetch?:
    | ((
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1]
      ) => ReturnType<typeof globalThis.fetch>)
    | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly url: string;
}

export type { MigrateConnection } from "./connection.ts";

const browserServerUrl = (input: string): string => {
  try {
    return new URL(input).toString();
  } catch {
    if (typeof globalThis.location === "undefined") {
      throw new Error(
        "A relative Migrate Server URL requires a browser location"
      );
    }
    return new URL(input, globalThis.location.href).toString();
  }
};

export const connectBrowserMigrateServer = ({
  bearerToken,
  credentials,
  fetch,
  signal,
  url,
}: BrowserMigrateConnectionInput): Promise<MigrateConnection> => {
  const fetchLayer =
    fetch === undefined
      ? FetchHttpClient.layer
      : FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(
              FetchHttpClient.Fetch,
              fetch as typeof globalThis.fetch
            )
          )
        );
  const httpClientLayer =
    credentials === undefined
      ? fetchLayer
      : fetchLayer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.RequestInit, { credentials })
          )
        );

  return connectMigrateHttpServer({
    ...(bearerToken === undefined ? {} : { bearerToken }),
    httpClientLayer,
    ...(signal === undefined ? {} : { signal }),
    url: browserServerUrl(url),
  });
};
