// biome-ignore-all lint/performance/noBarrelFile: Public Node client entrypoint intentionally exposes the complete Migrate Connection boundary.

import type { MigrateConnection } from "../connection.ts";
import {
  connectLocalMigrateServer,
  type LocalMigrateConnectionInput,
} from "./local-connection.ts";
import {
  connectRemoteMigrateServer,
  type RemoteMigrateConnectionInput,
} from "./remote-connection.ts";

export type { MigrateConnection } from "../connection.ts";
export {
  connectLocalMigrateServer,
  type LocalMigrateConnectionInput,
} from "./local-connection.ts";
export {
  connectRemoteMigrateServer,
  type RemoteMigrateConnectionInput,
} from "./remote-connection.ts";

export type MigrateServerConnectionInput =
  | ({ readonly kind: "local" } & LocalMigrateConnectionInput)
  | ({ readonly kind: "remote" } & RemoteMigrateConnectionInput);

export const connectMigrateServer = (
  input: MigrateServerConnectionInput
): Promise<MigrateConnection> =>
  input.kind === "local"
    ? connectLocalMigrateServer(input)
    : connectRemoteMigrateServer(input);
