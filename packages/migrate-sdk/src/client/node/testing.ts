// biome-ignore-all lint/performance/noBarrelFile: Public testing entrypoint intentionally exposes Node launcher test controls separately from the customer interface.

export {
  connectLocalMigrateServerWithBootstrap as connectLocalMigrateServerForTesting,
  type LocalMigrateServerBootstrapOptions,
  localMigrateServerEndpoint,
} from "./local-connection.ts";
