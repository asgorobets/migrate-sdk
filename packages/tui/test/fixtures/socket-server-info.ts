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
  MIGRATE_PROTOCOL_VERSION,
  type MigrateServerInfo,
  MigrateStreamingRpcs,
} from "migrate-sdk/protocol";
import {
  MigrateServer,
  MigrateStreamingServerHandlers,
} from "migrate-sdk/server";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};
const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const socketPath = argumentValue("--socket");
const variant =
  argumentValue("--variant") ?? argumentValue("--config") ?? "protocol";

if (socketPath === undefined) {
  throw new Error("Socket server fixture requires --socket");
}

const baseInfo: MigrateServerInfo = {
  environment: { id: "test" },
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  registryId: "test",
  sdkVersion: sdkPackage.version,
};
const makeServerInfo = (): MigrateServerInfo => {
  switch (variant) {
    case "malformed":
      return {
        ...baseInfo,
        environment: undefined,
      } as unknown as MigrateServerInfo;
    case "sdk":
      return { ...baseInfo, sdkVersion: "999.0.0" };
    default:
      return { ...baseInfo, protocolVersion: MIGRATE_PROTOCOL_VERSION + 1 };
  }
};
const serverInfo = makeServerInfo();
const unused = () => Effect.die("not used");
const ServerApplication = Layer.succeed(
  MigrateServer,
  MigrateServer.of({
    breakLock: unused,
    getActiveRuns: Effect.die("not used"),
    getDashboard: Effect.die("not used"),
    getMessages: unused,
    getServerInfo: Effect.succeed(serverInfo),
    getSourceIdentityHistory: unused,
    normalizeSourceIdentity: unused,
    observeRun: () => Stream.die("not used"),
    observeRunLease: unused,
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
const serverLayer = layerRpcServer(MigrateStreamingRpcs, {
  disableFatalDefects: true,
}).pipe(
  Layer.provide(
    MigrateStreamingServerHandlers.pipe(Layer.provide(ServerApplication))
  ),
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
