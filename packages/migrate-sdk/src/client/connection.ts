import type { Effect } from "effect";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateServerInfo,
} from "../protocol/index.ts";
import type { MigrateClientService } from "./index.ts";

export interface MigrateConnection {
  readonly client: MigrateClientService;
  readonly dispose: () => Promise<void>;
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<A>;
  readonly serverInfo: MigrateServerInfo;
}

export const validateMigrateServerProtocol = (
  serverInfo: MigrateServerInfo
): void => {
  if (serverInfo.protocolVersion !== MIGRATE_PROTOCOL_VERSION) {
    throw new Error(
      `Migrate Protocol version ${serverInfo.protocolVersion} is not supported; expected ${MIGRATE_PROTOCOL_VERSION}`
    );
  }
};
