#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { layer as layerNodeWorkerRunner } from "@effect/platform-node/NodeWorkerRunner";
import { Effect, Layer, Schema } from "effect";
import {
  layerProtocolWorkerRunner,
  layer as layerRpcServer,
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
import { makeConfiguredMigrationServerBackend } from "./migration-backend.ts";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};

interface ServerArguments {
  readonly configPath?: string;
  readonly cwd: string;
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

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];

    if (argument !== "--config" && argument !== "--cwd") {
      throw new Error(`Unknown Migrate Server option: ${argument}`);
    }

    if (value === undefined) {
      throw new Error(`${argument} requires a path`);
    }

    if (argument === "--config") {
      configPath = value;
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
  };
};

const main = Effect.gen(function* () {
  const parsed = yield* Effect.try({
    catch: (cause) =>
      new MigrateServerBootstrapError({
        cause,
        message: `Unable to start Migrate Server: ${cause}`,
      }),
    try: () => parseArguments(process.argv.slice(2)),
  });
  const runtime = yield* Effect.tryPromise({
    catch: (cause) =>
      new MigrateServerBootstrapError({
        cause,
        message: `Unable to load migration configuration: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      }),
    try: () =>
      loadConfiguredMigrationHost({
        ...(parsed.configPath === undefined
          ? {}
          : { configPath: parsed.configPath }),
        cwd: parsed.cwd,
      }),
  });
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
  const Handlers = MigrateServerHandlers.pipe(Layer.provide(ServerApplication));
  const Server = layerRpcServer(MigrateRpcs, {
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(Handlers),
    Layer.provide(layerProtocolWorkerRunner),
    Layer.provide(layerNodeWorkerRunner)
  );

  return yield* Layer.launch(Server);
});

runMain(main);
