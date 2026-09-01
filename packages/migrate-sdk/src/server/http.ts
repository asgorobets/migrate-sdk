import { Context, Effect, Layer, type Scope } from "effect";
import {
  HttpEffect,
  type HttpMiddleware,
  type HttpServerRequest,
  type HttpServerResponse,
} from "effect/unstable/http";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import { toHttpEffect } from "effect/unstable/rpc/RpcServer";
import { MigrateHttpRpcs } from "../protocol/index.ts";
import { MigrateHttpServerHandlers } from "./handlers.ts";
import type { MigrateServer } from "./service.ts";

export type MigrateServerHttpApp = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Scope.Scope | HttpServerRequest.HttpServerRequest
>;

export type MigrateServerHttpMiddleware<
  Error = never,
  Requirements = Scope.Scope | HttpServerRequest.HttpServerRequest,
> = HttpMiddleware.HttpMiddleware.Applied<
  Effect.Effect<HttpServerResponse.HttpServerResponse, Error, Requirements>,
  never,
  Scope.Scope | HttpServerRequest.HttpServerRequest
>;

export interface MigrateServerHttpHandler<Requirements = never> {
  readonly dispose: () => Promise<void>;
  readonly handler: [Requirements] extends [never]
    ? (request: Request, context?: Context.Context<never>) => Promise<Response>
    : (
        request: Request,
        context: Context.Context<Requirements>
      ) => Promise<Response>;
}

function toWebHandler<Provided, LayerError>(
  layer: Layer.Layer<MigrateServerHttp | Provided, LayerError>
): MigrateServerHttpHandler;
function toWebHandler<
  Provided,
  LayerError,
  MiddlewareError,
  MiddlewareRequirements,
  HandlerRequirements = Exclude<
    MiddlewareRequirements,
    | MigrateServerHttp
    | Provided
    | Scope.Scope
    | HttpServerRequest.HttpServerRequest
  >,
>(
  layer: Layer.Layer<MigrateServerHttp | Provided, LayerError>,
  middleware: MigrateServerHttpMiddleware<
    MiddlewareError,
    MiddlewareRequirements
  >
): MigrateServerHttpHandler<HandlerRequirements>;
function toWebHandler<
  Provided,
  LayerError,
  MiddlewareError,
  MiddlewareRequirements,
>(
  layer: Layer.Layer<MigrateServerHttp | Provided, LayerError>,
  middleware?: MigrateServerHttpMiddleware<
    MiddlewareError,
    MiddlewareRequirements
  >
) {
  if (middleware === undefined) {
    return HttpEffect.toWebHandlerLayerWith(layer, {
      toHandler: (context) =>
        Effect.succeed(Context.get(context, MigrateServerHttp)),
    });
  }

  return HttpEffect.toWebHandlerLayerWith(layer, {
    toHandler: (context) =>
      Effect.succeed(middleware(Context.get(context, MigrateServerHttp))),
  });
}

/**
 * Routerless Effect HTTP application that serves the Migrate RPC protocol.
 * The host composes transport middleware around this application and converts
 * the fully provided Layer to a Web handler at its framework boundary.
 */
export class MigrateServerHttp extends Context.Service<
  MigrateServerHttp,
  MigrateServerHttpApp
>()("@migrate-sdk/server/MigrateServerHttp") {
  static readonly make: Effect.Effect<
    MigrateServerHttpApp,
    never,
    MigrateServer | Scope.Scope
  > = Effect.gen(function* () {
    const rpcContext = yield* Layer.build(
      Layer.merge(MigrateHttpServerHandlers, layerNdjson)
    );

    return yield* toHttpEffect(MigrateHttpRpcs, {
      disableTracing: true,
      spanPrefix: "MigrateServer",
    }).pipe(Effect.provide(rpcContext));
  });

  static readonly layer: Layer.Layer<MigrateServerHttp, never, MigrateServer> =
    Layer.effect(MigrateServerHttp, MigrateServerHttp.make);

  static readonly toWebHandler = toWebHandler;
}
