import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hostBinaryTarget } from "../bin/binary-targets.js";
import {
  bunPlatformPackageCandidates,
  resolveBunExecutable,
  resolveNativeExecutable,
  tuiChildEnvironment,
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

  it("passes the exact Node executable to the Bun application", () => {
    expect(tuiChildEnvironment({ EXISTING: "value" }, "/runtime/node")).toEqual(
      {
        EXISTING: "value",
        MIGRATE_TUI_NODE_EXECUTABLE: "/runtime/node",
      }
    );
  });
});

describe("native Migrate TUI launcher", () => {
  const directories = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });
  const nativePackage = async (version) => {
    const directory = await mkdtemp(join(tmpdir(), "migrate-native-launcher-"));
    directories.push(directory);
    await mkdir(join(directory, "bin"));
    const manifestPath = join(directory, "package.json");
    await writeFile(manifestPath, JSON.stringify({ version }));
    return { directory, manifestPath };
  };
  it("reports omitted optional dependencies without falling back to another runtime", async () => {
    await expect(
      resolveNativeExecutable({
        resolvePackage: () => {
          throw new Error("missing");
        },
      })
    ).rejects.toThrow("optional dependencies enabled");
  });
  it("rejects a platform package with a different launcher version", async () => {
    const { manifestPath } = await nativePackage("0.0.0");
    await expect(
      resolveNativeExecutable({ resolvePackage: () => manifestPath })
    ).rejects.toThrow(`does not match launcher ${packageJson.version}`);
  });
  it("rejects a non-native command in a correctly versioned package", async () => {
    const { directory, manifestPath } = await nativePackage(
      packageJson.version
    );
    const executable = join(directory, "bin", hostBinaryTarget().executable);
    await writeFile(executable, "echo not a native executable");
    await chmod(executable, 0o755);
    await expect(
      resolveNativeExecutable({ resolvePackage: () => manifestPath })
    ).rejects.toThrow("missing or invalid");
  });
});
