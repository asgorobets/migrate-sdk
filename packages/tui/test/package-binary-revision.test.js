import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageDirectory = fileURLToPath(new URL("..", import.meta.url));
const directories = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function packagingFixture(revision, inheritedEnvironment = process.env) {
  // Keep Git discovery in this checkout without putting temporary files in
  // dist, which a concurrent package smoke test can be packing.
  const fixtureDirectory = join(
    packageDirectory,
    "node_modules/.cache/tui-binary-revision"
  );
  await mkdir(fixtureDirectory, { recursive: true });
  const directory = await mkdtemp(join(fixtureDirectory, "case-"));
  directories.push(directory);
  for (const child of [
    "scripts",
    "bin",
    "dist/binary/linux-x64-glibc",
    "dist/distribution",
  ]) {
    await mkdir(join(directory, child), { recursive: true });
  }
  for (const file of [
    "scripts/package-binaries.mjs",
    "scripts/package-manager.mjs",
    "scripts/verify-binary.mjs",
    "bin/binary-targets.js",
  ]) {
    await copyFile(join(packageDirectory, file), join(directory, file));
  }
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "revision-test",
      type: "module",
      version: "1.2.3",
      dependencies: { bun: "1.3.14", "@opentui/core": "0.4.5" },
    })
  );
  const bytes = Buffer.alloc(64);
  bytes.write("7f454c46", 0, "hex");
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(62, 18);
  const build = join(directory, "dist/binary/linux-x64-glibc");
  await writeFile(join(build, "migrate-tui"), bytes);
  await writeFile(
    join(build, "build.json"),
    JSON.stringify({
      target: "linux-x64-glibc",
      compileTarget: "bun-linux-x64-baseline",
      executable: "migrate-tui",
      version: "1.2.3",
      bun: "1.3.14",
      opentui: "0.4.5",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      revision,
    })
  );
  const sentinel = join(directory, "dist/distribution/keep");
  await writeFile(sentinel, "previous candidate");
  const manager = join(directory, "pnpm.cjs");
  await writeFile(
    manager,
    'console.error("PACK_REACHED"); process.exit(93);\n'
  );
  // Windows keeps only the first case-insensitive key when spawning. Remove
  // pnpm's inherited uppercase variant so this test always uses the helper.
  const env = Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      ([key]) => key.toLowerCase() !== "npm_execpath"
    )
  );
  env.npm_execpath = manager;
  expect(
    Object.keys(env).filter((key) => key.toLowerCase() === "npm_execpath")
  ).toEqual(["npm_execpath"]);
  const result = spawnSync(
    process.execPath,
    [resolve(directory, "scripts/package-binaries.mjs")],
    {
      cwd: directory,
      encoding: "utf8",
      env,
    }
  );
  if (result.error) {
    throw result.error;
  }
  expect(await readFile(sentinel, "utf8")).toBe("previous candidate");
  return result;
}

describe("binary packaging source revision", () => {
  it("rejects a single stale binary before packing current JavaScript", async () => {
    const result = await packagingFixture("0".repeat(40));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("source revision");
    expect(result.stderr).not.toContain("PACK_REACHED");
  });
  it("allows a current-revision binary to reach the package stage", async () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageDirectory,
      encoding: "utf8",
    }).trim();
    const result = await packagingFixture(revision);
    expect(result.stderr).toContain("PACK_REACHED");
    expect(result.stderr).not.toContain("source revision");
  });
  it("overrides an inherited uppercase package manager variable on Windows", async () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: packageDirectory,
      encoding: "utf8",
    }).trim();
    const result = await packagingFixture(revision, {
      ...process.env,
      NPM_EXECPATH: "C:\\tools\\pnpm.cjs",
    });
    expect(result.stderr).toContain("PACK_REACHED");
  });
});
