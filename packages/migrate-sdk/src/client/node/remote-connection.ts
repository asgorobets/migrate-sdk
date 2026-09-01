import {
  connectHttpMigrateServer,
  type HttpMigrateConnectionInput,
} from "../http.ts";

export type RemoteMigrateConnectionInput = HttpMigrateConnectionInput;

export const connectRemoteMigrateServer = connectHttpMigrateServer;
