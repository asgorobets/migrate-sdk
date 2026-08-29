import {
  connectLocalMigrateServerForTesting,
  type LocalMigrateServerBootstrapOptions,
} from "migrate-sdk/client/node/testing";
import type {
  LoadMigrationTuiInput,
  MigrationTuiRuntime,
} from "../../src/runtime.ts";
import { makeMigrationTuiRuntimeWithLocalConnection } from "../../src/server/tui-runtime.ts";

export const makeMigrationTuiRuntimeForTesting = (
  input: LoadMigrationTuiInput,
  localBootstrapOptions: LocalMigrateServerBootstrapOptions
): Promise<MigrationTuiRuntime> =>
  makeMigrationTuiRuntimeWithLocalConnection(input, (localInput) =>
    connectLocalMigrateServerForTesting(localInput, localBootstrapOptions)
  );
