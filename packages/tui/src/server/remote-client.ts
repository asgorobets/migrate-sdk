import { Effect, Layer, ManagedRuntime } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http";
import { layerProtocolHttp } from "effect/unstable/rpc/RpcClient";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import { MigrateClient } from "migrate-sdk/client";
import type { MigrateConnection } from "./connection.ts";
import { validateMigrateServerInfo } from "./connection.ts";

export interface RemoteMigrateConnectionInput {
  readonly bearerToken?: string | undefined;
  readonly fetch?:
    | ((
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1]
      ) => ReturnType<typeof globalThis.fetch>)
    | undefined;
  readonly url: string;
}

const ipv4Part = /^\d{1,3}$/;

const remoteServerUrl = (input: string): string => {
  const url = new URL(input);
  const hostname = url.hostname.toLowerCase();
  const ipv4Parts = hostname.split(".");
  const ipv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === "127" &&
    ipv4Parts.every((part) => ipv4Part.test(part) && Number(part) <= 255);
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    ipv4Loopback;

  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(
      "Remote Migrate Server must use HTTPS; HTTP is supported only for loopback development"
    );
  }

  return url.toString();
};

export const connectRemoteMigrateServer = async ({
  bearerToken,
  fetch,
  url: inputUrl,
}: RemoteMigrateConnectionInput): Promise<MigrateConnection> => {
  const url = remoteServerUrl(inputUrl);
  const fetchClientLayer =
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
  const remoteHttpClientLayer = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) => {
      const authenticated =
        bearerToken === undefined
          ? client
          : HttpClient.mapRequest(client, (request) =>
              HttpClientRequest.bearerToken(request, bearerToken)
            );

      return HttpClient.filterStatusOk(authenticated);
    })
  ).pipe(Layer.provide(fetchClientLayer));
  const protocolLayer = layerProtocolHttp({
    url,
  }).pipe(Layer.provide(layerNdjson), Layer.provide(remoteHttpClientLayer));
  const clientLayer = MigrateClient.httpLayer.pipe(
    Layer.provide(protocolLayer)
  );
  const runtime = ManagedRuntime.make(clientLayer);
  let disposed = false;
  const dispose = async () => {
    if (disposed) {
      return;
    }
    disposed = true;
    await runtime.dispose();
  };

  try {
    const client = await runtime.runPromise(MigrateClient);
    const serverInfo = await runtime.runPromise(client.GetServerInfo());
    validateMigrateServerInfo(serverInfo);

    return {
      client,
      dispose,
      runPromise: (effect, options?: { readonly signal?: AbortSignal }) =>
        runtime.runPromise(effect, options),
      serverInfo,
    };
  } catch (cause) {
    await dispose();
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Unable to connect to Migrate Server ${url}: ${message}`, {
      cause,
    });
  }
};
