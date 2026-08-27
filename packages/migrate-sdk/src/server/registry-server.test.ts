import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import {
  MIGRATE_SDK_VERSION,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  toMigrationDefinitionRegistryId,
} from "../index.ts";
import { MIGRATE_PROTOCOL_VERSION } from "../protocol/index.ts";
import { RegistryMigrateServer } from "./registry-server.ts";
import { MigrateServer } from "./service.ts";

describe("RegistryMigrateServer", () => {
  it.effect("constructs a server from a registry and execution layer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const registryId = toMigrationDefinitionRegistryId("catalog");
        const serverLayer = RegistryMigrateServer.layer({
          registry: MigrationDefinitionRegistry.make({
            definitions: [],
            id: registryId,
          }),
          environment: { id: "test", label: "Test" },
        }).pipe(
          Layer.provide(
            Layer.succeed(
              MigrationExecutable,
              MigrationExecutable.inlineService
            )
          )
        );
        const context = yield* Layer.build(serverLayer);
        const server = Context.get(context, MigrateServer);

        expect(yield* server.getServerInfo).toEqual({
          environment: { id: "test", label: "Test" },
          protocolVersion: MIGRATE_PROTOCOL_VERSION,
          registryId,
          sdkVersion: MIGRATE_SDK_VERSION,
        });
        expect((yield* server.getDashboard).dashboard.rows).toEqual([]);
      })
    )
  );
});
