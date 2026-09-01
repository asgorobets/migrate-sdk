#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect, Layer, Schema } from "effect";
import { Protocol as RpcServerProtocol } from "effect/unstable/rpc/RpcServer";
import { SocketServer } from "effect/unstable/socket";
import { toMigrationDefinitionRegistryId } from "../../domain/ids.ts";
import { MigrateServerInstanceId } from "../../protocol/index.ts";
import {
  loadLocalMigrateServerRuntime,
  MigrateServer,
  MigrateStreamingServerHandlers,
  makeRegistryMigrateServerBackend,
} from "../../server/index.ts";
import { waitForLocalMigrateServerIdle } from "./local-server-lifecycle.ts";
import { runLocalMigrateServerTransport } from "./local-server-transport.ts";

interface ServerArguments {
  readonly configPath?: string;
  readonly cwd: string;
  readonly endpointPath: string;
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
  let endpointPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (
      argument !== "--config" &&
      argument !== "--cwd" &&
      argument !== "--endpoint"
    ) {
      throw new Error(`Unknown Migrate Server option: ${argument}`);
    }

    if (value === undefined) {
      throw new Error(`${argument} requires a path`);
    }

    if (argument === "--config") {
      configPath = value;
    } else if (argument === "--endpoint") {
      endpointPath = value;
    } else {
      cwd = value;
    }
    index += 1;
  }

  if (cwd === undefined) {
    throw new Error("Migrate Server requires --cwd");
  }
  if (endpointPath === undefined) {
    throw new Error("Migrate Server requires --endpoint");
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    cwd,
    endpointPath,
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
    const instanceId = MigrateServerInstanceId.make(randomUUID());
    const authToken = randomBytes(32).toString("base64url");
    const ServerApplication = MigrateServer.layer({
      backend: makeRegistryMigrateServerBackend(runtime),
      environment: {
        id: `local:${parsed.cwd}`,
        label: basename(runtime.configPath),
      },
      ...(process.platform === "win32" ? { instanceId } : {}),
      registryId,
    });
    const Handlers = MigrateStreamingServerHandlers.pipe(
      Layer.provide(ServerApplication)
    );
    const serveUntilIdle = Effect.gen(function* () {
      const protocol = yield* RpcServerProtocol;
      yield* SocketServer.SocketServer;

      return yield* waitForLocalMigrateServerIdle({
        clientIds: protocol.clientIds,
        hasActiveExecutions: runtime.hasActiveExecutions,
        listActiveRuns: runtime.listActiveRuns,
      });
    });

    return yield* runLocalMigrateServerTransport(serveUntilIdle, {
      authToken,
      endpointPath: parsed.endpointPath,
      handlers: Handlers,
      instanceId,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new MigrateServerBootstrapError({
            cause,
            message: cause.message,
          })
      )
    );
  })
);

runMain(main);
