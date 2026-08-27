#!/usr/bin/env node

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { NodeSocketServer } from "@effect/platform-node";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect, Layer, Schema } from "effect";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import {
  layerProtocolSocketServer,
  layer as layerRpcServer,
  Protocol as RpcServerProtocol,
} from "effect/unstable/rpc/RpcServer";
import { toMigrationDefinitionRegistryId } from "migrate-sdk";
import { MigrateStreamingRpcs } from "migrate-sdk/protocol";
import {
  loadLocalMigrateServerRuntime,
  MigrateServer,
  MigrateStreamingServerHandlers,
  makeRegistryMigrateServerBackend,
} from "migrate-sdk/server";
import { removeLocalMigrateServerEndpoint } from "./local-endpoint.ts";
import { waitForLocalMigrateServerIdle } from "./server-lifecycle.ts";

interface ServerArguments {
  readonly configPath?: string;
  readonly cwd: string;
  readonly socketPath: string;
}

class MigrateServerBootstrapError extends Schema.TaggedError<MigrateServerBootstrapError>()(
  "MigrateServerBootstrapError",
  {
    cause: Schema.optional(Schema.Defect()),
    message: Schema.String,
  }
) {}

const parseArguments = (args: readonly string[]): ServerArguments => {
  let configPath: string | undefined;
  let cwd: string | undefined;
  let socketPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (
      argument !== "--config" &&
      argument !== "--cwd" &&
      argument !== "--socket"
    ) {
      throw new Error(`Unknown Migrate Server option: ${argument}`);
    }

    if (value === undefined) {
      throw new Error(`${argument} requires a path`);
    }

    if (argument === "--config") {
      configPath = value;
    } else if (argument === "--socket") {
      socketPath = value;
    } else {
      cwd = value;
    }
    index += 1;
  }

  if (cwd === undefined) {
    throw new Error("Migrate Server requires --cwd");
  }
  if (socketPath === undefined) {
    throw new Error("Migrate Server requires --socket");
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    cwd,
    socketPath,
  };
};

const main = Effect.scoped(
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      catch: (cause) =>
        new MigrateServerBootstrapError({
          cause,
          message: `Unable to start Migrate Server: ${cause}`,
        }),
      try: () => parseArguments(process.argv.slice(2)),
    });
    const runtime = yield* loadLocalMigrateServerRuntime({
      ...(parsed.configPath === undefined
        ? {}
        : { configPath: parsed.configPath }),
      cwd: parsed.cwd,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new MigrateServerBootstrapError({
            cause,
            message: `Unable to load migration configuration: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          })
      )
    );
    const registryId =
      runtime.registryId ??
      toMigrationDefinitionRegistryId(
        `local:${createHash("sha256")
          .update(
            runtime.rows
              .map((row) => row.entry.id)
              .sort()
              .join("\n")
          )
          .digest("hex")}`
      );
    const ServerApplication = MigrateServer.layer({
      backend: makeRegistryMigrateServerBackend(runtime),
      environment: {
        id: `local:${parsed.cwd}`,
        label: basename(runtime.configPath),
      },
      registryId,
    });
    const Handlers = MigrateStreamingServerHandlers.pipe(
      Layer.provide(ServerApplication)
    );
    const socketPath = parsed.socketPath;
    const socketProtocolLayer = layerProtocolSocketServer.pipe(
      Layer.provide(NodeSocketServer.layer({ path: socketPath })),
      Layer.provide(layerNdjson)
    );
    const socketServerLayer = layerRpcServer(MigrateStreamingRpcs, {
      disableFatalDefects: true,
    }).pipe(Layer.provide(Handlers), Layer.provideMerge(socketProtocolLayer));
    const serveUntilIdle = Effect.gen(function* () {
      const protocol = yield* RpcServerProtocol;

      return yield* waitForLocalMigrateServerIdle({
        clientIds: protocol.clientIds,
        hasActiveExecutions: runtime.hasActiveExecutions,
        listActiveRuns: runtime.listActiveRuns,
      });
    }).pipe(
      Effect.provide(socketServerLayer),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => removeLocalMigrateServerEndpoint(socketPath))
      )
    );

    return yield* serveUntilIdle;
  })
);

runMain(main);
