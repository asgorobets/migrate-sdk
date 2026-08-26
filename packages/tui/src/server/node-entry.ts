#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { NodeSocketServer } from "@effect/platform-node";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as layerNodeWorkerRunner } from "@effect/platform-node/NodeWorkerRunner";
import { Effect, Layer, Schema } from "effect";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import {
  layerProtocolSocketServer,
  layerProtocolWorkerRunner,
  layer as layerRpcServer,
  Protocol as RpcServerProtocol,
} from "effect/unstable/rpc/RpcServer";
import { toMigrationDefinitionRegistryId } from "migrate-sdk";
import {
  MIGRATE_CAPABILITIES,
  MIGRATE_PROTOCOL_VERSION,
  MigrateRpcs,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import { MigrateServer, MigrateServerHandlers } from "migrate-sdk/server";
import { loadConfiguredMigrationHost } from "../runtime.ts";
import { removeLocalMigrateServerEndpoint } from "./local-endpoint.ts";
import { makeConfiguredMigrationServerBackend } from "./migration-backend.ts";
import { waitForLocalMigrateServerIdle } from "./server-lifecycle.ts";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};

interface ServerArguments {
  readonly configPath?: string;
  readonly cwd: string;
  readonly socketPath?: string;
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

  return {
    ...(configPath === undefined ? {} : { configPath }),
    cwd,
    ...(socketPath === undefined ? {} : { socketPath }),
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
    const runtime = yield* loadConfiguredMigrationHost({
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
    const serverInfo: MigrateServerInfo = {
      capabilities: [...MIGRATE_CAPABILITIES],
      configPath: runtime.configPath,
      environment: {
        id: `local:${parsed.cwd}`,
        label: "Local",
      },
      protocolVersion: MIGRATE_PROTOCOL_VERSION,
      registryId,
      runtime: { name: "node", version: process.versions.node },
      sdkVersion: sdkPackage.version,
    };
    const ServerApplication = MigrateServer.layer({
      backend: makeConfiguredMigrationServerBackend(runtime),
      serverInfo,
    });
    const Handlers = MigrateServerHandlers.pipe(
      Layer.provide(ServerApplication)
    );
    if (parsed.socketPath === undefined) {
      const workerServerLayer = layerRpcServer(MigrateRpcs, {
        disableFatalDefects: true,
      }).pipe(
        Layer.provide(Handlers),
        Layer.provide(layerProtocolWorkerRunner),
        Layer.provide(layerNodeWorkerRunner)
      );

      return yield* Layer.launch(workerServerLayer);
    }

    const socketPath = parsed.socketPath;
    const socketProtocolLayer = layerProtocolSocketServer.pipe(
      Layer.provide(NodeSocketServer.layer({ path: socketPath })),
      Layer.provide(layerNdjson)
    );
    const socketServerLayer = layerRpcServer(MigrateRpcs, {
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
