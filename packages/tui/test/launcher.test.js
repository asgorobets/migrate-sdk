import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bunPlatformPackageCandidates,
  resolveBunExecutable,
} from "../bin/launcher.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

describe("Migrate TUI Node launcher", () => {
  it("selects safe Bun package fallbacks", () => {
    expect(
      bunPlatformPackageCandidates({ arch: "arm64", platform: "darwin" })
    ).toEqual(["@oven/bun-darwin-aarch64"]);
    expect(
      bunPlatformPackageCandidates({
        arch: "x64",
        platform: "linux",
        report: { header: { glibcVersionRuntime: "2.39" } },
      })
    ).toEqual(["@oven/bun-linux-x64-baseline", "@oven/bun-linux-x64"]);
    expect(
      bunPlatformPackageCandidates({
        arch: "arm64",
        platform: "linux",
        report: { header: {} },
      })
    ).toEqual(["@oven/bun-linux-aarch64-musl"]);
    expect(
      bunPlatformPackageCandidates({ arch: "x64", platform: "win32" })
    ).toEqual(["@oven/bun-windows-x64-baseline", "@oven/bun-windows-x64"]);
  });

  it("rejects unsupported platforms before spawning", () => {
    expect(() =>
      bunPlatformPackageCandidates({ arch: "x64", platform: "freebsd" })
    ).toThrow("Unsupported platform for Migrate TUI: freebsd-x64");
  });

  it("resolves the package-provided Bun runtime", async () => {
    await expect(resolveBunExecutable()).resolves.toContain("bun");
  });

  it("reports the package version without loading Bun or the SDK", () => {
    const version = execFileSync(
      process.execPath,
      [resolve(packageDirectory, "bin", "migrate-tui.js"), "--version"],
      { encoding: "utf8" }
    );

    expect(version.trim()).toBe(packageJson.version);
  });
});
