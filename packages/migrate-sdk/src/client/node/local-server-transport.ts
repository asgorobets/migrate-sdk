import { NodeSocketServer } from "@effect/platform-node";
import { Effect, Layer, Schema } from "effect";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import {
  layerProtocolSocketServer,
  layer as layerRpcServer,
  type Protocol,
} from "effect/unstable/rpc/RpcServer";
import { SocketServer } from "effect/unstable/socket";
import {
  type MigrateServerInstanceId,
  MigrateStreamingRpcs,
} from "../../protocol/index.ts";
import {
  LocalAuthorizedMigrateStreamingRpcs,
  localMigrateServerAuthorizationLayer,
} from "./local-authorization.ts";
import {
  LocalMigrateServerTcpDiscoveryJson,
  localMigrateServerLoopbackHost,
  publishLocalMigrateServerTcpDiscovery,
  removeLocalMigrateServerEndpoint,
} from "./local-endpoint.ts";

type MigrateStreamingHandlerServices = Rpc.ToHandler<
  Rpcs<typeof MigrateStreamingRpcs>
>;

interface LocalMigrateServerTransportOptions {
  readonly authToken: string;
  readonly endpointPath: string;
  readonly handlers: Layer.Layer<MigrateStreamingHandlerServices>;
  readonly instanceId: MigrateServerInstanceId;
}

export class LocalMigrateServerTransportError extends Schema.TaggedError<LocalMigrateServerTransportError>()(
  "LocalMigrateServerTransportError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

const transportLayer = ({
  authToken,
  endpointPath,
  handlers,
}: LocalMigrateServerTransportOptions) => {
  const listener = NodeSocketServer.layer(
    process.platform === "win32"
      ? { host: localMigrateServerLoopbackHost, port: 0 }
      : { path: endpointPath }
  );
  const rpc = (
    process.platform === "win32"
      ? layerRpcServer(LocalAuthorizedMigrateStreamingRpcs, {
          disableFatalDefects: true,
        }).pipe(Layer.provide(localMigrateServerAuthorizationLayer(authToken)))
      : layerRpcServer(MigrateStreamingRpcs, {
          disableFatalDefects: true,
        })
  ).pipe(
    Layer.provide(handlers),
    Layer.provideMerge(layerProtocolSocketServer),
    Layer.provideMerge(listener),
    Layer.provide(layerNdjson)
  );

  return rpc;
};

const publishWindowsDiscovery = ({
  authToken,
  endpointPath,
  instanceId,
}: LocalMigrateServerTransportOptions) =>
  Effect.gen(function* () {
    const socketServer = yield* SocketServer.SocketServer;

    if (socketServer.address._tag !== "TcpAddress") {
      return yield* new LocalMigrateServerTransportError({
        message: "Windows Migrate Server requires a TCP listener",
      });
    }

    const discovery = yield* Schema.encodeEffect(
      LocalMigrateServerTcpDiscoveryJson
    )({
      authToken,
      host: localMigrateServerLoopbackHost,
      instanceId,
      pid: process.pid,
      port: socketServer.address.port,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new LocalMigrateServerTransportError({
            cause,
            message: "Unable to encode Migrate Server discovery",
          })
      )
    );

    yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) =>
          new LocalMigrateServerTransportError({
            cause,
            message: `Unable to publish Migrate Server discovery: ${cause}`,
          }),
        try: () =>
          publishLocalMigrateServerTcpDiscovery(endpointPath, discovery),
      }),
      () =>
        Effect.sync(() =>
          removeLocalMigrateServerEndpoint(
            endpointPath,
            process.platform,
            discovery
          )
        )
    );
  });

export const runLocalMigrateServerTransport = <Value, Error>(
  effect: Effect.Effect<Value, Error, Protocol | SocketServer.SocketServer>,
  options: LocalMigrateServerTransportOptions
): Effect.Effect<
  Value,
  Error | LocalMigrateServerTransportError | SocketServer.SocketServerError
> => {
  const serve =
    process.platform === "win32"
      ? publishWindowsDiscovery(options).pipe(Effect.andThen(effect))
      : effect;

  return serve.pipe(
    Effect.provide(transportLayer(options)),
    Effect.scoped,
    Effect.ensuring(
      process.platform === "win32"
        ? Effect.void
        : Effect.sync(() =>
            removeLocalMigrateServerEndpoint(options.endpointPath)
          )
    )
  );
};
