import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releaseBinaryTargets } from "../bin/binary-targets.js";
import { packageManagerCommand } from "../scripts/package-manager.mjs";
import {
  publishedPackage,
  publishNativePackages,
  validateNativeRelease,
} from "../scripts/publish-native.mjs";

const manifest = { name: "@migrate-sdk/tui", version: "1.2.3" };
const revision = "a".repeat(40);
const directories = [];
const json = (path, value) => writeFile(path, JSON.stringify(value));
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tui-native-release-"));
  directories.push(directory);
  await mkdir(resolve(directory, "tarballs"));
  const packages = Object.fromEntries(
    releaseBinaryTargets.map((target) => [target.packageName, manifest.version])
  );
  const hashes = [];
  for (const [id, name, filename] of [
    ...releaseBinaryTargets.map((target) => [
      target.id,
      target.packageName,
      `migrate-sdk-tui-${target.id}-${manifest.version}.tgz`,
    ]),
    ["tui", manifest.name, `migrate-sdk-tui-${manifest.version}.tgz`],
  ]) {
    await mkdir(resolve(directory, "packages", id), { recursive: true });
    const data = {
      name,
      version: manifest.version,
      private: false,
      migrateTuiSourceRevision: revision,
      ...(id === "tui"
        ? { migrateTuiBinaryDistribution: true, optionalDependencies: packages }
        : {}),
    };
    await json(resolve(directory, "packages", id, "package.json"), data);
    await writeFile(resolve(directory, "tarballs", filename), name);
    hashes.push(
      `${createHash("sha256").update(name).digest("hex")}  tarballs/${filename}`
    );
  }
  await writeFile(resolve(directory, "SHA256SUMS"), hashes.join("\n"));
  await json(resolve(directory, "distribution.json"), {
    version: manifest.version,
    revision,
    releaseReady: true,
    targets: releaseBinaryTargets.map((target) => target.id),
    packages,
  });
  return directory;
}

describe("native publication", () => {
  it("makes pnpm pack use the staged launcher selected for Changesets publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tui-publish-directory-"));
    directories.push(directory);
    await mkdir(resolve(directory, "stage"));
    await json(resolve(directory, "package.json"), {
      ...manifest,
      dependencies: { bun: "1.3.14" },
      publishConfig: { directory: "stage" },
    });
    await json(resolve(directory, "stage/package.json"), {
      ...manifest,
      migrateTuiBinaryDistribution: true,
    });
    const tarball = resolve(directory, "launcher.tgz");
    const command = packageManagerCommand(["pack", "--out", tarball]);
    execFileSync(command.executable, command.args, { cwd: directory });
    const packed = JSON.parse(
      execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
        encoding: "utf8",
      })
    );
    expect(packed.migrateTuiBinaryDistribution).toBe(true);
    expect(packed.dependencies).toBeUndefined();
  });
  it("rejects a host-only candidate before any publication", async () => {
    const directory = await fixture();
    const path = resolve(directory, "distribution.json");
    const info = JSON.parse(await readFile(path, "utf8"));
    info.targets.pop();
    await json(path, info);
    await expect(
      validateNativeRelease(directory, manifest, revision)
    ).rejects.toThrow("every tested target");
  });
  it("rejects altered tarballs and required JavaScript dependencies", async () => {
    const directory = await fixture();
    const releases = await validateNativeRelease(directory, manifest, revision);
    await writeFile(releases[0].tarball, "modified");
    await expect(
      validateNativeRelease(directory, manifest, revision)
    ).rejects.toThrow("checksum");
    const path = resolve(directory, "packages/tui/package.json");
    const info = JSON.parse(await readFile(path, "utf8"));
    info.dependencies = { bun: "1.3.14" };
    await json(path, info);
    await expect(
      validateNativeRelease(directory, manifest, revision)
    ).rejects.toThrow("only exact platform");
  });
  it("fails on registry authentication errors instead of trying to publish", () => {
    expect(() =>
      publishedPackage("package", "1.0.0", () => ({
        status: 1,
        stdout: JSON.stringify({ error: { code: "E401" } }),
        stderr: "unauthorized",
      }))
    ).toThrow("Unable to check");
  });
  it("verifies every platform before the launcher is selected and supports partial retries", () => {
    const releases = [
      { name: "first", version: "1.2.3", tarball: "first.tgz" },
      { name: "second", version: "1.2.3", tarball: "second.tgz" },
    ];
    const calls = [];
    const published = new Set(["first"]);
    publishNativePackages(releases, revision, (args) => {
      calls.push(args);
      if (args[0] === "publish") {
        published.add(args[1].replace(".tgz", ""));
        return { status: 0, stdout: "", stderr: "" };
      }
      return published.has(args[1].split("@")[0])
        ? {
            status: 0,
            stdout: JSON.stringify({ migrateTuiSourceRevision: revision }),
          }
        : { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }) };
    });
    expect(calls.filter((args) => args[0] === "publish")).toEqual([
      ["publish", "second.tgz", "--access", "public", "--ignore-scripts"],
    ]);
    expect(calls.at(-1)).toEqual([
      "view",
      "second@1.2.3",
      "--json",
      "--prefer-online",
    ]);
  });
  it("stops on a failed platform publish or another revision's immutable package", () => {
    const releases = [
      { name: "first", version: "1.2.3", tarball: "first.tgz" },
    ];
    expect(() =>
      publishNativePackages(releases, revision, () => ({
        status: 0,
        stdout: JSON.stringify({ migrateTuiSourceRevision: "older" }),
      }))
    ).toThrow("another source revision");
    expect(() =>
      publishNativePackages(releases, revision, (args) => ({
        status: 1,
        stdout: JSON.stringify({
          error: { code: args[0] === "view" ? "E404" : "ENEEDAUTH" },
        }),
        stderr: "",
      }))
    ).toThrow("Native publish failed");
  });
});
