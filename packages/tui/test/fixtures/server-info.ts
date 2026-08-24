import { createRequire } from "node:module";
import { layer as layerNodeWorkerRunner } from "@effect/platform-node/NodeWorkerRunner";
import { Effect, Layer, Stream } from "effect";
import { makeRunMain } from "effect/Runtime";
import {
  layerProtocolWorkerRunner,
  layer as layerRpcServer,
} from "effect/unstable/rpc/RpcServer";
import {
  MIGRATE_CAPABILITIES,
  MigrateRpcs,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";
import { MigrateServer, MigrateServerHandlers } from "migrate-sdk/server";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};
const configIndex = process.argv.indexOf("--config");
const variant = configIndex === -1 ? "protocol" : process.argv[configIndex + 1];
const baseInfo: MigrateServerInfo = {
  capabilities: [...MIGRATE_CAPABILITIES],
  environment: { id: "test" },
  protocolVersion: 1,
  registryId: "test",
  runtime: { name: "node", version: process.versions.node },
  sdkVersion: sdkPackage.version,
};
const makeServerInfo = (): MigrateServerInfo => {
  switch (variant) {
    case "malformed":
      return {
        ...baseInfo,
        environment: undefined,
      } as unknown as MigrateServerInfo;
    case "capabilities":
      return { ...baseInfo, capabilities: ["dashboard"] };
    case "sdk":
      return { ...baseInfo, sdkVersion: "999.0.0" };
    default:
      return { ...baseInfo, protocolVersion: 2 };
  }
};
const serverInfo = makeServerInfo();
const unused = () => Effect.die("not used");
const ServerApplication = Layer.succeed(
  MigrateServer,
  MigrateServer.of({
    breakLock: unused,
    cancelExecution: unused,
    getDashboard: Effect.die("not used"),
    getMessages: unused,
    getServerInfo: Effect.succeed(serverInfo),
    getSourceIdentityHistory: unused,
    normalizeSourceIdentity: unused,
    observeExecution: () => Stream.die("not used"),
    prepareOperation: unused,
    scanSource: unused,
    startOperation: unused,
  })
);
const Server = layerRpcServer(MigrateRpcs, {
  disableFatalDefects: true,
}).pipe(
  Layer.provide(MigrateServerHandlers.pipe(Layer.provide(ServerApplication))),
  Layer.provide(layerProtocolWorkerRunner),
  Layer.provide(layerNodeWorkerRunner)
);

makeRunMain(({ teardown }) => teardown)(Layer.launch(Server));
