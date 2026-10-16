import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { removeTemporaryDirectory } from "./remove-temporary-directory.mjs";

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

  it("launches a renderer from an installation path longer than Windows MAX_PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migrate-launcher-path-"));
    try {
      const installed = join(
        directory,
        "nested-installation-".repeat(5),
        "pnpm-cache-".repeat(9)
      );
      const runtimeDirectory = join(installed, "node_modules/bun/bin");
      await mkdir(runtimeDirectory, { recursive: true });
      await mkdir(join(installed, "bin"));
      await mkdir(join(installed, "dist"));
      await writeFile(
        join(installed, "package.json"),
        JSON.stringify({ type: "module", version: "0.0.0" })
      );
      await writeFile(
        join(installed, "node_modules/bun/package.json"),
        JSON.stringify({ name: "bun", version: "1.3.14" })
      );
      for (const file of [
        "migrate-tui.js",
        "launcher.js",
        "binary-targets.js",
      ]) {
        await copyFile(
          join(packageDirectory, "bin", file),
          join(installed, "bin", file)
        );
      }
      const executable = join(runtimeDirectory, "bun.exe");
      expect(executable.length).toBeGreaterThan(260);
      await copyFile(await resolveBunExecutable(), executable);
      await chmod(executable, 0o755);
      await writeFile(
        join(installed, "dist/bin.js"),
        'console.log("Renderer launched from a deep installation");\n'
      );
      expect(
        execFileSync(
          process.execPath,
          [join(installed, "bin/migrate-tui.js"), "--help"],
          { encoding: "utf8" }
        )
      ).toContain("Renderer launched from a deep installation");
    } finally {
      await removeTemporaryDirectory(directory);
    }
  }, 15_000);
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
