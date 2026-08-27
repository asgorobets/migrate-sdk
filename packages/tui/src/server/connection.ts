import type { Effect } from "effect";
import { MIGRATE_SDK_VERSION } from "migrate-sdk";
import type { MigrateClientService } from "migrate-sdk/client";
import {
  MIGRATE_PROTOCOL_VERSION,
  type MigrateServerInfo,
} from "migrate-sdk/protocol";

export interface MigrateConnection {
  readonly client: MigrateClientService;
  readonly dispose: () => Promise<void>;
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: { readonly signal?: AbortSignal }
  ) => Promise<A>;
  readonly serverInfo: MigrateServerInfo;
}

export const validateMigrateServerInfo = (
  serverInfo: MigrateServerInfo
): void => {
  if (serverInfo.protocolVersion !== MIGRATE_PROTOCOL_VERSION) {
    throw new Error(
      `Migrate Protocol version ${serverInfo.protocolVersion} is not supported; expected ${MIGRATE_PROTOCOL_VERSION}`
    );
  }
  if (serverInfo.sdkVersion !== MIGRATE_SDK_VERSION) {
    throw new Error(
      `Migrate SDK version ${serverInfo.sdkVersion} is not supported; expected ${MIGRATE_SDK_VERSION}`
    );
  }
};
