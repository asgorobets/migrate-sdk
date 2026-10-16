import { describe, expect, it } from "vitest";
import { parseMigrationTuiArguments } from "./cli-arguments.ts";

describe("Migrate TUI arguments", () => {
  it("supports manual status loading for local and remote connections", () => {
    expect(parseMigrationTuiArguments(["--status", "manual"]).status).toBe(
      "manual"
    );
    expect(
      parseMigrationTuiArguments([
        "--server",
        "https://migrate.example/rpc",
        "--status",
        "manual",
      ]).status
    ).toBe("manual");
    expect(parseMigrationTuiArguments(["--status", "background"]).status).toBe(
      "background"
    );
    expect(() => parseMigrationTuiArguments(["--status"])).toThrow(
      "--status requires background or manual"
    );
    expect(() => parseMigrationTuiArguments(["--status", "always"])).toThrow(
      "--status requires background or manual"
    );
  });

  it("enables local tracing alongside a configuration path", () => {
    expect(
      parseMigrationTuiArguments(["--otel", "--config", "migrate.config.ts"])
    ).toEqual({
      configPath: "migrate.config.ts",
      help: false,
      otel: true,
      version: false,
    });
  });

  it("requires remote tracing to be configured on its execution host", () => {
    expect(() =>
      parseMigrationTuiArguments([
        "--otel",
        "--server",
        "https://migrate.example/api/rpc",
      ])
    ).toThrow("--otel configures local execution");
  });

  it("selects a remote Migrate Server", () => {
    expect(
      parseMigrationTuiArguments([
        "--server",
        "https://migrate.example/api/rpc",
      ])
    ).toEqual({
      help: false,
      serverUrl: "https://migrate.example/api/rpc",
      version: false,
    });
  });

  it("does not combine a remote server with a local config", () => {
    expect(() =>
      parseMigrationTuiArguments([
        "--config",
        "migrate.config.ts",
        "--server",
        "https://migrate.example/api/rpc",
      ])
    ).toThrow("--config and --server cannot be used together");
  });
});
