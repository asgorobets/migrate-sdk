import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { hostBinaryTarget } from "../bin/binary-targets.js";
import { packageManagerCommand } from "../scripts/package-manager.mjs";
import { testNativeDlx } from "./native-dlx.mjs";
import { removeTemporaryDirectory } from "./remove-temporary-directory.mjs";

const packageDirectory = resolve(import.meta.dirname, "..");
const sdkDirectory = resolve(packageDirectory, "../migrate-sdk");
const distribution = resolve(packageDirectory, "dist/distribution");
const manifest = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8")
);
const target = hostBinaryTarget();
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), "migrate-tui-binary-"));
const pnpm = "pnpm";
const completedMigrationPattern = /packaging-fixture {2}COMPLETE/;

function run(command, args, options = {}) {
  const invocation =
    command === "pnpm"
      ? packageManagerCommand(args)
      : { executable: command, args };
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd ?? packageDirectory,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status}):\n${result.stdout}${result.stderr}`
    );
  }
  return result.stdout;
}

async function terminalMigration(command, cwd, env) {
  if (process.platform === "win32") {
    return;
  }
  const pilotty = resolve(packageDirectory, "node_modules/.bin/pilotty");
  const socketDirectory = await mkdtemp(join("/tmp", "mtb-"));
  const terminalEnv = { ...env, PILOTTY_SOCKET_DIR: socketDirectory };
  const session = "binary";
  const call = (args) => run(pilotty, args, { cwd, env: terminalEnv });
  try {
    call([
      "spawn",
      "--name",
      session,
      "--cwd",
      cwd,
      ...command,
      "--config",
      "migrate.config.ts",
    ]);
    call(["resize", "-s", session, "120", "36"]);
    call(["wait-for", "-s", session, "-t", "30000", "Status reloaded"]);
    call(["key", "-s", session, "r"]);
    call([
      "wait-for",
      "-s",
      session,
      "-t",
      "20000",
      "packaging-fixture  COMPLETE",
    ]);
    assert.match(
      call(["snapshot", "-s", session, "--format", "text"]),
      completedMigrationPattern
    );
    call(["key", "-s", session, "q"]);
  } catch (cause) {
    const snapshot = spawnSync(
      pilotty,
      ["snapshot", "-s", session, "--format", "text"],
      { env: terminalEnv, encoding: "utf8" }
    );
    throw new Error(
      `${cause.message}\n${snapshot.stdout ?? ""}${snapshot.stderr ?? ""}`,
      { cause }
    );
  } finally {
    spawnSync(pilotty, ["kill", "-s", session], {
      env: terminalEnv,
      stdio: "ignore",
    });
    spawnSync(pilotty, ["stop"], { env: terminalEnv, stdio: "ignore" });
    await rm(socketDirectory, { recursive: true, force: true });
  }
}

try {
  const distributionInfo = JSON.parse(
    await readFile(resolve(distribution, "distribution.json"), "utf8")
  );
  assert.equal(distributionInfo.version, manifest.version);
  assert.ok(distributionInfo.targets.includes(target.id));
  const sums = await readFile(resolve(distribution, "SHA256SUMS"), "utf8");
  for (const line of sums.trim().split("\n")) {
    const [expected, relative] = line.split("  ");
    const actual = createHash("sha256")
      .update(await readFile(resolve(distribution, relative)))
      .digest("hex");
    assert.equal(actual, expected, `Checksum: ${relative}`);
  }
  const relocated = resolve(temp, target.executable);
  await copyFile(
    resolve(packageDirectory, "dist/binary", target.id, target.executable),
    relocated
  );
  await chmod(relocated, 0o755);
  const emptyPath = resolve(temp, "empty-path");
  await mkdir(emptyPath);
  const cleanEnv = {
    ...process.env,
    PATH: emptyPath,
    NODE_PATH: "",
    BUN_OPTIONS: "",
    BUN_BE_BUN: "",
    MIGRATE_TUI_NODE_EXECUTABLE: process.execPath,
  };
  assert.equal(
    run(relocated, ["--version"], { cwd: temp, env: cleanEnv }).trim(),
    manifest.version
  );
  assert.match(
    run(relocated, ["--help"], { cwd: temp, env: cleanEnv }),
    /--server/
  );
  console.log("Relocated binary starts without Node/Bun on PATH");

  await testNativeDlx({
    distribution,
    target,
    version: manifest.version,
    temp,
  });

  run(pnpm, ["pack", "--pack-destination", temp], { cwd: sdkDirectory });
  const sdkTarball = (await readdir(temp)).find((name) =>
    name.endsWith(".tgz")
  );
  assert.ok(sdkTarball, "SDK tarball");
  const tarballs = resolve(distribution, "tarballs");
  const fixture = resolve(temp, "fixture");
  await mkdir(fixture);
  await writeFile(
    resolve(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "migrate-tui-native-consumer",
        private: true,
        type: "module",
        scripts: { tui: "migrate-tui" },
        dependencies: {
          "@migrate-sdk/tui": `file:${resolve(tarballs, `migrate-sdk-tui-${manifest.version}.tgz`)}`,
          [target.packageName]: `file:${resolve(tarballs, `migrate-sdk-tui-${target.id}-${manifest.version}.tgz`)}`,
          "migrate-sdk": `file:${resolve(temp, sdkTarball)}`,
          effect: `^${require("effect/package.json").version}`,
        },
      },
      null,
      2
    )}\n`
  );
  await copyFile(
    resolve(packageDirectory, "examples/packaging.config.ts"),
    resolve(fixture, "migrate.config.ts")
  );
  run(
    pnpm,
    [
      "install",
      "--ignore-scripts",
      "--strict-peer-dependencies",
      "--engine-strict",
    ],
    { cwd: fixture }
  );
  const launcher = resolve(
    fixture,
    "node_modules/@migrate-sdk/tui/bin/migrate-tui.js"
  );
  assert.match(
    run(process.execPath, [launcher, "--help"], { cwd: fixture }),
    /--server/
  );
  assert.match(
    run(pnpm, ["run", "tui", "--help"], { cwd: fixture }),
    /--server/
  );
  const installed = JSON.parse(
    await readFile(
      resolve(fixture, "node_modules/@migrate-sdk/tui/package.json"),
      "utf8"
    )
  );
  assert.equal(installed.dependencies?.bun, undefined);
  assert.equal(
    installed.optionalDependencies[target.packageName],
    manifest.version
  );
  console.log(
    "Local npm package installation works with lifecycle scripts disabled"
  );

  // Compile the same runtime path into a headless client for Windows and Unix RPC acceptance.
  const bun = resolve(packageDirectory, "node_modules/bun/bin/bun.exe");
  const probe = resolve(
    temp,
    process.platform === "win32" ? "client-probe.exe" : "client-probe"
  );
  run(bun, [
    "build",
    "--compile",
    "--compile-autoload-package-json",
    "--minify",
    `--target=${target.compileTarget}`,
    "--define=MIGRATE_TUI_STANDALONE=true",
    `--define=MIGRATE_TUI_VERSION=${JSON.stringify(manifest.version)}`,
    "./test/fixtures/binary-client-smoke.ts",
    "--outfile",
    probe,
  ]);
  // Implicit config discovery must choose the parent's SDK, even when the
  // current directory has an incompatible SDK of its own.
  const nestedProject = resolve(fixture, "nested");
  const nestedSdk = resolve(nestedProject, "node_modules/migrate-sdk");
  await mkdir(nestedSdk, { recursive: true });
  await writeFile(
    resolve(nestedSdk, "package.json"),
    JSON.stringify({
      name: "migrate-sdk",
      version: "0.0.0",
      exports: { "./package.json": "./package.json" },
    })
  );
  assert.match(
    run(probe, [], {
      cwd: nestedProject,
      env:
        process.platform === "win32"
          ? {
              ...cleanEnv,
              // Local Windows IPC hardens its endpoint with the OS PowerShell utility.
              // Keep OS tools available while excluding installed Node/Bun directories.
              PATH: [
                join(process.env.SystemRoot, "System32"),
                join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
              ].join(delimiter),
            }
          : cleanEnv,
    }),
    /executed the Node-only migration/
  );
  console.log(
    "Compiled client discovered the parent config and executed the Node-only migration"
  );
  const withoutRuntimes = [
    "/usr/bin/env",
    `PATH=${emptyPath}`,
    `MIGRATE_TUI_NODE_EXECUTABLE=${process.execPath}`,
  ];
  await terminalMigration(
    [...withoutRuntimes, relocated],
    fixture,
    process.env
  );
  await terminalMigration(
    [...withoutRuntimes, process.execPath, launcher],
    fixture,
    process.env
  );
  console.log(
    `Binary, native package, checksums, and Node migration smoke passed (${target.id})`
  );
} finally {
  await removeTemporaryDirectory(temp);
}
