import { timingSafeEqual } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import {
  make as makeRpcClient,
  type Protocol,
  type RpcClient,
} from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";
import {
  type ForClient,
  layerClient,
  Service as RpcMiddlewareService,
} from "effect/unstable/rpc/RpcMiddleware";
import { MigrateStreamingRpcs } from "../../protocol/index.ts";
import { MigrateClient } from "../index.ts";
import {
  type MigrateStreamingRpcClient,
  makeStreamingMigrateClientService,
} from "../internal/client-service.ts";

const localAuthorizationHeader = "authorization";
const localAuthorizationFailureMessage =
  "Local Migrate Server authorization failed";

export class LocalMigrateServerUnauthorizedError extends Schema.TaggedError<LocalMigrateServerUnauthorizedError>()(
  "LocalMigrateServerUnauthorizedError",
  { message: Schema.String }
) {}

class LocalMigrateServerAuthorization extends RpcMiddlewareService<LocalMigrateServerAuthorization>()(
  "@migrate-sdk/client/node/LocalMigrateServerAuthorization",
  { error: LocalMigrateServerUnauthorizedError, requiredForClient: true }
) {}

export const LocalAuthorizedMigrateStreamingRpcs =
  MigrateStreamingRpcs.middleware(LocalMigrateServerAuthorization);

const authorizationMatches = (
  authorization: string | undefined,
  token: string
): boolean => {
  if (authorization === undefined) {
    return false;
  }

  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${token}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const localMigrateServerAuthorizationLayer = (
  token: string
): Layer.Layer<LocalMigrateServerAuthorization> =>
  Layer.succeed(
    LocalMigrateServerAuthorization,
    LocalMigrateServerAuthorization.of((effect, { headers }) =>
      authorizationMatches(headers[localAuthorizationHeader], token)
        ? effect
        : Effect.fail(
            new LocalMigrateServerUnauthorizedError({
              message: localAuthorizationFailureMessage,
            })
          )
    )
  );

export const isLocalMigrateServerAuthorizationFailure = (
  cause: unknown
): cause is LocalMigrateServerUnauthorizedError =>
  Schema.is(LocalMigrateServerUnauthorizedError)(cause);

const localMigrateServerAuthorizationClientLayer = (
  token: string
): Layer.Layer<ForClient<LocalMigrateServerAuthorization>> =>
  layerClient(LocalMigrateServerAuthorization, ({ next, request }) =>
    next({
      ...request,
      headers: Headers.set(
        request.headers,
        localAuthorizationHeader,
        `Bearer ${token}`
      ),
    })
  );

export type LocalAuthorizedMigrateRpcClient = RpcClient<
  Rpcs<typeof LocalAuthorizedMigrateStreamingRpcs>,
  RpcClientError
>;

class RawLocalAuthorizedMigrateClient extends Context.Service<
  RawLocalAuthorizedMigrateClient,
  LocalAuthorizedMigrateRpcClient
>()("@migrate-sdk/client/node/RawLocalAuthorizedMigrateClient") {}

export interface LocalMigrateServerHandshakeClientService {
  readonly GetServerInfo: LocalAuthorizedMigrateRpcClient["GetServerInfo"];
}

export class LocalMigrateServerHandshakeClient extends Context.Service<
  LocalMigrateServerHandshakeClient,
  LocalMigrateServerHandshakeClientService
>()("@migrate-sdk/client/node/LocalMigrateServerHandshakeClient") {}

const makeLocalMigrateClient = makeRpcClient(
  LocalAuthorizedMigrateStreamingRpcs
);

export const localAuthorizedMigrateClientLayer = (
  token: string
): Layer.Layer<
  LocalMigrateServerHandshakeClient | MigrateClient,
  never,
  Protocol
> => {
  const RawClient = Layer.effect(
    RawLocalAuthorizedMigrateClient,
    makeLocalMigrateClient
  ).pipe(Layer.provide(localMigrateServerAuthorizationClientLayer(token)));
  const PublicClient = Layer.effect(
    MigrateClient,
    Effect.map(RawLocalAuthorizedMigrateClient, (client) =>
      // The immutable token has already succeeded during the connection
      // handshake, so later calls cannot add an authorization failure.
      makeStreamingMigrateClientService(client as MigrateStreamingRpcClient)
    )
  );
  const HandshakeClient = Layer.effect(
    LocalMigrateServerHandshakeClient,
    Effect.map(RawLocalAuthorizedMigrateClient, (client) => ({
      GetServerInfo: client.GetServerInfo,
    }))
  );

  return Layer.merge(PublicClient, HandshakeClient).pipe(
    Layer.provide(RawClient)
  );
};
