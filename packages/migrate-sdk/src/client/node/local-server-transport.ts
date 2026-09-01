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
  guardLocalMigrateServerEndpoint,
  type LocalMigrateServerEndpointClaim,
  LocalMigrateServerTcpDiscoveryJson,
  localMigrateServerLoopbackHost,
  publishLocalMigrateServerTcpDiscovery,
  readLocalMigrateServerPosixEndpointIdentity,
  removeLocalMigrateServerEndpoint,
  settleLocalMigrateServerEndpointClaim,
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

const capturePosixEndpointOwnership = ({
  endpointPath,
}: LocalMigrateServerTransportOptions) =>
  Effect.try({
    catch: (cause) =>
      new LocalMigrateServerTransportError({
        cause,
        message: `Unable to capture Migrate Server endpoint ownership: ${cause}`,
      }),
    try: () => {
      const identity =
        readLocalMigrateServerPosixEndpointIdentity(endpointPath);
      if (identity === undefined) {
        throw new Error(
          `Migrate Server endpoint was not published: ${endpointPath}`
        );
      }
      return identity;
    },
  });

const runPosixTransport = <Value, Error>(
  effect: Effect.Effect<Value, Error, Protocol | SocketServer.SocketServer>,
  options: LocalMigrateServerTransportOptions
) =>
  Effect.suspend(() => {
    let endpointClaim: LocalMigrateServerEndpointClaim | undefined;
    const serve = Effect.gen(function* () {
      const identity = yield* capturePosixEndpointOwnership(options);
      return yield* effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            endpointClaim = guardLocalMigrateServerEndpoint(
              options.endpointPath,
              (claimedPath) => {
                const claimedIdentity =
                  readLocalMigrateServerPosixEndpointIdentity(claimedPath);
                return (
                  claimedIdentity !== undefined &&
                  claimedIdentity.device === identity.device &&
                  claimedIdentity.inode === identity.inode
                );
              }
            );
          })
        )
      );
    });

    const settleEndpointClaim = Effect.sync(() => {
      if (endpointClaim !== undefined) {
        settleLocalMigrateServerEndpointClaim(endpointClaim);
      }
    });

    return serve.pipe(
      Effect.provide(transportLayer(options)),
      Effect.scoped,
      Effect.ensuring(settleEndpointClaim)
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
