import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
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
  publishLocalMigrateServerPosixEndpoint,
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

const makePosixListenerEndpoint = (publicEndpoint: string): string =>
  join(
    dirname(publicEndpoint),
    `.m-${randomUUID().replaceAll("-", "").slice(0, 24)}`
  );

const publishPosixEndpoint = (
  listenerEndpoint: string,
  publicEndpoint: string
) =>
  Effect.acquireRelease(
    Effect.try({
      catch: (cause) =>
        new LocalMigrateServerTransportError({
          cause,
          message: `Unable to publish Migrate Server endpoint: ${cause}`,
        }),
      try: () =>
        publishLocalMigrateServerPosixEndpoint(
          listenerEndpoint,
          publicEndpoint
        ),
    }),
    (identity) =>
      Effect.sync(() =>
        removeLocalMigrateServerEndpoint(
          publicEndpoint,
          process.platform,
          undefined,
          identity
        )
      )
  );

const runPosixTransport = <Value, Error>(
  effect: Effect.Effect<Value, Error, Protocol | SocketServer.SocketServer>,
  options: LocalMigrateServerTransportOptions
) =>
  Effect.suspend(() => {
    const listenerEndpoint = makePosixListenerEndpoint(options.endpointPath);
    const serve = Effect.gen(function* () {
      yield* publishPosixEndpoint(listenerEndpoint, options.endpointPath);
      return yield* effect;
    });

    return serve.pipe(
      Effect.provide(
        transportLayer({ ...options, endpointPath: listenerEndpoint })
      ),
      Effect.scoped
    );
  });

export const runLocalMigrateServerTransport = <Value, Error>(
  effect: Effect.Effect<Value, Error, Protocol | SocketServer.SocketServer>,
  options: LocalMigrateServerTransportOptions
): Effect.Effect<
  Value,
  Error | LocalMigrateServerTransportError | SocketServer.SocketServerError
> => {
  if (process.platform !== "win32") {
    return runPosixTransport(effect, options);
  }

  const serve = publishWindowsDiscovery(options).pipe(Effect.andThen(effect));
  return serve.pipe(Effect.provide(transportLayer(options)), Effect.scoped);
};
