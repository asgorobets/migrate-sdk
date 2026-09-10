import { describe, expect, it } from "vitest";
import { parseMigrationTuiArguments } from "./cli-arguments.ts";

describe("Migrate TUI arguments", () => {
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
