import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import {
  layerProtocolHttp,
  layer as layerRpcServer,
} from "effect/unstable/rpc/RpcServer";
import { MigrateHttpRpcs } from "../protocol/index.ts";
import { MigrateHttpServerHandlers } from "./handlers.ts";
import type { MigrateServer } from "./service.ts";

interface MigrateServerHttpHandlerBaseOptions {
  readonly path: `/${string}`;
}

export type MigrateServerHttpHandlerOptions =
  MigrateServerHttpHandlerBaseOptions &
    (
      | {
          readonly authentication: "external";
          readonly authorize?: never;
        }
      | {
          readonly authentication?: never;
          readonly authorize: (request: Request) => Effect.Effect<boolean>;
        }
    );

export interface MigrateServerHttpHandler {
  readonly dispose: () => Promise<void>;
  readonly handler: (request: Request) => Promise<Response>;
}

/**
 * Exposes a Migrate Server through Effect RPC's Web-standard HTTP transport.
 * Authentication remains application-owned so deployments can use their
 * existing identity provider without exposing resource credentials to clients.
 */
export const makeMigrateServerHttpHandler = <Error>(
  serverLayer: Layer.Layer<MigrateServer, Error>,
  options: MigrateServerHttpHandlerOptions
): MigrateServerHttpHandler => {
  const { path } = options;

  if (
    options.authentication !== "external" &&
    options.authorize === undefined
  ) {
    throw new Error(
      "Migrate Server HTTP authentication must be provided or delegated externally"
    );
  }

  const protocolLayer = layerProtocolHttp({ path });
  const rpcLayer = layerRpcServer(MigrateHttpRpcs, {
    disableTracing: true,
    spanPrefix: "MigrateServer",
  }).pipe(
    Layer.provide(MigrateHttpServerHandlers),
    Layer.provide(protocolLayer),
    Layer.provide(layerNdjson),
    Layer.provide(serverLayer)
  );
  const webHandler = HttpRouter.toWebHandler(rpcLayer, {
    disableLogger: true,
  });

  if (options.authentication === "external") {
    return webHandler;
  }

  const authorize = options.authorize;

  return {
    dispose: webHandler.dispose,
    handler: (request) =>
      Effect.runPromise(authorize(request)).then((authorized) =>
        authorized
          ? webHandler.handler(request)
          : new Response("Unauthorized", { status: 401 })
      ),
  };
};
