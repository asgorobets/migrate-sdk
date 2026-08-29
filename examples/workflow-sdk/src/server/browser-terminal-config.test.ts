import { ConfigProvider, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
  BrowserTerminalConfig,
  parseBrowserTerminalMigrationServerUrl,
} from "./browser-terminal-config";
import {
  MigrateServerAccess,
  makeMigrateServerAccess,
} from "./migrate-server-access";

describe("browser terminal migration server URL", () => {
  it.each([
    "https://workflow.example.com/api/migrate",
    "https://workflow.example.com/api/migrate/",
  ])("normalizes the RPC endpoint for Effect's trailing-slash requests: %s", (value) => {
    expect(parseBrowserTerminalMigrationServerUrl(value).href).toBe(
      "https://workflow.example.com/api/migrate/"
    );
  });

  it.each([
    undefined,
    "",
    "http://workflow.example.com/api/migrate",
    "https://user:secret@workflow.example.com/api/migrate",
    "https://workflow.example.com/api/migrate?destination=elsewhere",
    "https://workflow.example.com/api/migrate#fragment",
  ])("rejects an unsafe endpoint: %s", (value) => {
    expect(() => parseBrowserTerminalMigrationServerUrl(value)).toThrow();
  });
});

describe("BrowserTerminalConfig", () => {
  it("loads normalized values through replaceable Layers", async () => {
    const configProvider = ConfigProvider.fromUnknown({
      MIGRATE_SERVER_PUBLIC_URL: " https://workflow.example.com/api/migrate ",
      MIGRATE_TUI_SANDBOX_SNAPSHOT_ID: " snap_example ",
    });
    const configLayer = BrowserTerminalConfig.layer.pipe(
      Layer.provide(
        Layer.succeed(
          MigrateServerAccess,
          makeMigrateServerAccess(" migrate-secret ")
        )
      )
    );

    const config = await Effect.runPromise(
      BrowserTerminalConfig.pipe(
        Effect.provide(configLayer),
        Effect.provideService(ConfigProvider.ConfigProvider, configProvider)
      )
    );

    expect(config.migrateServerToken).toBe("migrate-secret");
    expect(config.migrationServerUrl.href).toBe(
      "https://workflow.example.com/api/migrate/"
    );
    expect(config.snapshotId).toBe("snap_example");
  });
});
