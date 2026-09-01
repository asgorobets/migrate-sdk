import { Effect, Layer, ManagedRuntime } from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { layerProtocolHttp } from "effect/unstable/rpc/RpcClient";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import {
  type MigrateConnection,
  validateMigrateServerProtocol,
} from "../connection.ts";
import { MigrateClient } from "../index.ts";

export interface MigrateHttpConnectionOptions {
  readonly bearerToken?: string | undefined;
  readonly httpClientLayer: Layer.Layer<HttpClient.HttpClient>;
  readonly signal?: AbortSignal | undefined;
  readonly url: string;
}

const ipv4Part = /^\d{1,3}$/;

export const migrateHttpServerUrl = (input: string): string => {
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

const connectMigrateHttpServerUnsafe = ({
  bearerToken,
  httpClientLayer,
  signal,
  url: inputUrl,
}: MigrateHttpConnectionOptions): Promise<MigrateConnection> => {
  const url = migrateHttpServerUrl(inputUrl);
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
  ).pipe(Layer.provide(httpClientLayer));
  const protocolLayer = layerProtocolHttp({ url }).pipe(
    Layer.provide(layerNdjson),
    Layer.provide(remoteHttpClientLayer)
  );
  const clientLayer = MigrateClient.httpLayer.pipe(
    Layer.provide(protocolLayer)
  );
  const runtime = ManagedRuntime.make(clientLayer);
  let disposed = false;
  const dispose = () => {
    if (disposed) {
      return Promise.resolve();
    }
    disposed = true;
    return runtime.dispose();
  };

  return runtime
    .runPromise(
      Effect.gen(function* () {
        const client = yield* MigrateClient;
        const serverInfo = yield* client.GetServerInfo();
        validateMigrateServerProtocol(serverInfo);

        return {
          client,
          dispose,
          runPromise: <A, E>(
            effect: Effect.Effect<A, E>,
            options?: { readonly signal?: AbortSignal }
          ) => runtime.runPromise(effect, options),
          serverInfo,
        } satisfies MigrateConnection;
      }),
      { signal }
    )
    .catch((cause: unknown) =>
      dispose().then(() => {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(
          `Unable to connect to Migrate Server ${url}: ${message}`,
          { cause }
        );
      })
    );
};

export const connectMigrateHttpServer = (
  options: MigrateHttpConnectionOptions
): Promise<MigrateConnection> =>
  Promise.resolve().then(() => connectMigrateHttpServerUnsafe(options));
