import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect, Layer, Stream } from "effect";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateServerInfo,
  MigrateServerInstanceId,
} from "migrate-sdk/protocol";
import {
  MigrateServer,
  MigrateStreamingServerHandlers,
} from "migrate-sdk/server";
import { runLocalMigrateServerTransport } from "../../../migrate-sdk/src/client/node/local-server-transport.ts";

const require = createRequire(import.meta.url);
const sdkPackage = require("migrate-sdk/package.json") as {
  readonly version: string;
};
const argumentValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const endpointPath = argumentValue("--endpoint");
const variant =
  argumentValue("--variant") ?? argumentValue("--config") ?? "protocol";

if (endpointPath === undefined) {
  throw new Error("Socket server fixture requires --endpoint");
}

const instanceId = MigrateServerInstanceId.make(randomUUID());
const authToken = randomBytes(32).toString("base64url");
const baseInfo: MigrateServerInfo = {
  environment: { id: "test" },
  ...(process.platform === "win32" ? { instanceId } : {}),
  protocolVersion: MIGRATE_PROTOCOL_VERSION,
  registryId: "test",
  sdkVersion: sdkPackage.version,
};
const makeServerInfo = (): MigrateServerInfo => {
  switch (variant) {
    case "identity":
      return {
        ...baseInfo,
        instanceId: MigrateServerInstanceId.make("wrong-server"),
      };
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
const serve = runLocalMigrateServerTransport(Effect.never, {
  authToken,
  endpointPath,
  handlers: MigrateStreamingServerHandlers.pipe(
    Layer.provide(ServerApplication)
  ),
  instanceId,
});

runMain(serve);
