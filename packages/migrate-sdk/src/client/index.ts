import { Context, Layer } from "effect";
import {
  make as makeRpcClient,
  type RpcClient,
} from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import type { Rpcs } from "effect/unstable/rpc/RpcGroup";
import { MigrateRpcs } from "../protocol/index.ts";

export type MigrateClientService = RpcClient<
  Rpcs<typeof MigrateRpcs>,
  RpcClientError
>;

export class MigrateClient extends Context.Service<
  MigrateClient,
  MigrateClientService
>()("@migrate-sdk/client/MigrateClient") {
  static readonly make = makeRpcClient(MigrateRpcs);

  static readonly layer = Layer.effect(MigrateClient, MigrateClient.make);
}
