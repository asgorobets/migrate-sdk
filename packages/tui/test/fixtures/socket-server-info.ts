import { unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { NodeSocketServer } from "@effect/platform-node";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect, Layer, Stream } from "effect";
import { layerNdjson } from "effect/unstable/rpc/RpcSerialization";
import {
  layerProtocolSocketServer,
  layer as layerRpcServer,
} from "effect/unstable/rpc/RpcServer";
import {
  MIGRATE_CAPABILITIES,
  MIGRATE_PROTOCOL_VERSION,
  MigrateRpcs,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import { MigrateServer, MigrateServerHandlers } from "migrate-sdk/server";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};
const socketIndex = process.argv.indexOf("--socket");
const socketPath = process.argv[socketIndex + 1];
const variantIndex = process.argv.indexOf("--variant");
const variant =
  variantIndex === -1 ? "protocol" : process.argv[variantIndex + 1];

if (socketIndex === -1 || socketPath === undefined) {
  throw new Error("Socket server fixture requires --socket");
}

const baseInfo: MigrateServerInfo = {
  capabilities: [...MIGRATE_CAPABILITIES],
  environment: { id: "test" },
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  registryId: "test",
  runtime: { name: "node", version: process.versions.node },
  sdkVersion: sdkPackage.version,
};
const serverInfo: MigrateServerInfo =
  variant === "malformed"
    ? ({ ...baseInfo, environment: undefined } as unknown as MigrateServerInfo)
    : { ...baseInfo, protocolVersion: MIGRATE_PROTOCOL_VERSION + 1 };
const unused = () => Effect.die("not used");
const ServerApplication = Layer.succeed(
  MigrateServer,
  MigrateServer.of({
    breakLock: unused,
    cancelExecution: unused,
    getActiveRuns: Effect.die("not used"),
    getDashboard: Effect.die("not used"),
    getMessages: unused,
    getServerInfo: Effect.succeed(serverInfo),
    getSourceIdentityHistory: unused,
    normalizeSourceIdentity: unused,
    observeExecution: () => Stream.die("not used"),
    observeRun: () => Stream.die("not used"),
    prepareOperation: unused,
    scanSource: unused,
    startOperation: unused,
    stopRun: unused,
  })
);
const socketProtocolLayer = layerProtocolSocketServer.pipe(
  Layer.provide(NodeSocketServer.layer({ path: socketPath })),
  Layer.provide(layerNdjson)
);
const serverLayer = layerRpcServer(MigrateRpcs, {
  disableFatalDefects: true,
}).pipe(
  Layer.provide(MigrateServerHandlers.pipe(Layer.provide(ServerApplication))),
  Layer.provideMerge(socketProtocolLayer)
);
const removeSocket = Effect.sync(() => {
  try {
    unlinkSync(socketPath);
  } catch (cause) {
    if (
      !(cause instanceof Error && "code" in cause) ||
      (cause as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw cause;
    }
  }
});

runMain(Layer.launch(serverLayer).pipe(Effect.ensuring(removeSocket)));
