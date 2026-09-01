import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import type { MigrateConnection } from "./connection.ts";
import { connectMigrateHttpServer } from "./internal/http-connection.ts";

export interface HttpMigrateConnectionInput {
  readonly bearerToken?: string | undefined;
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

export const connectHttpMigrateServer = ({
  bearerToken,
  fetch,
  signal,
  url,
}: HttpMigrateConnectionInput): Promise<MigrateConnection> => {
  const httpClientLayer =
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

  return connectMigrateHttpServer({
    ...(bearerToken === undefined ? {} : { bearerToken }),
    httpClientLayer,
    ...(signal === undefined ? {} : { signal }),
    url,
  });
};
