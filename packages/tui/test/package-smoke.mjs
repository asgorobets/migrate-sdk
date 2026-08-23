import { spawnSync } from "node:child_process";
import {
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
import { basename, join, resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const sdkDirectory = resolve(repositoryDirectory, "packages/migrate-sdk");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const require = createRequire(import.meta.url);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n` +
        `${result.stdout ?? ""}${result.stderr ?? ""}`
    );
  }

  return result.stdout ?? "";
};

const runPackedMigration = async ({ command, fixtureDirectory }) => {
  if (process.platform === "win32") {
    return;
  }

  const pilotty = resolve(packageDirectory, "node_modules", ".bin", "pilotty");
  const socketDirectory = resolve(
    "/tmp",
    `migrate-tui-package-pilotty-${process.pid}`
  );
  const session = `migrate-tui-packed-${process.pid}`;
  const env = { ...process.env, PILOTTY_SOCKET_DIR: socketDirectory };
  await mkdir(socketDirectory, { recursive: true });

  try {
    run(
      pilotty,
      [
        "spawn",
        "--name",
        session,
        "--cwd",
        fixtureDirectory,
        command,
        "--config",
        "migrate.config.ts",
      ],
      { capture: true, cwd: fixtureDirectory, env }
    );
    run(pilotty, ["resize", "-s", session, "120", "36"], {
      capture: true,
      cwd: fixtureDirectory,
      env,
    });
    run(
      pilotty,
      ["wait-for", "-s", session, "-t", "30000", "Status reloaded"],
      { capture: true, cwd: fixtureDirectory, env }
    );
    run(pilotty, ["key", "-s", session, "r"], {
      capture: true,
      cwd: fixtureDirectory,
      env,
    });
    run(
      pilotty,
      [
        "wait-for",
        "-s",
        session,
        "-t",
        "10000",
        "packaging-fixture  SUCCEEDED",
      ],
      { capture: true, cwd: fixtureDirectory, env }
    );
    const snapshot = run(
      pilotty,
      [
        "snapshot",
        "-s",
        session,
        "--settle",
        "150",
        "--strict",
        "--format",
        "text",
      ],
      { capture: true, cwd: fixtureDirectory, env }
    );

    if (!snapshot.includes("packaging-fixture  SUCCEEDED")) {
      throw new Error(
        `Packed TUI did not execute the fixture migration\n${snapshot}`
      );
    }
  } finally {
    spawnSync(pilotty, ["key", "-s", session, "q"], {
      env,
      stdio: "ignore",
    });
    spawnSync(pilotty, ["stop"], { env, stdio: "ignore" });
    await rm(socketDirectory, { force: true, recursive: true });
  }
};

const findTarball = async (directory, prefix) => {
  const files = await readdir(directory);
  const tarball = files.find(
    (file) => file.startsWith(prefix) && file.endsWith(".tgz")
  );

  if (tarball === undefined) {
    throw new Error(`Packed tarball was not found for ${prefix}`);
  }

  return resolve(directory, tarball);
};

const parsePackOutput = (output) => {
  const jsonStart = output.lastIndexOf("\n{");
  return JSON.parse(output.slice(jsonStart < 0 ? 0 : jsonStart + 1));
};

const tempDirectory = await mkdtemp(join(tmpdir(), "migrate-tui-package-"));

try {
  const fixtureDirectory = resolve(tempDirectory, "fixture");
  await mkdir(fixtureDirectory);

  run(pnpm, ["pack", "--pack-destination", tempDirectory], {
    capture: true,
    cwd: sdkDirectory,
  });
  const tuiPackOutput = run(
    pnpm,
    ["pack", "--json", "--pack-destination", tempDirectory],
    {
      capture: true,
      cwd: packageDirectory,
    }
  );
  const packedTui = parsePackOutput(tuiPackOutput);
  if (packedTui.files.some((file) => file.path.startsWith("dist/binary/"))) {
    throw new Error("Packed TUI included direct-binary build artifacts");
  }

  const packageJson = JSON.parse(
    await readFile(resolve(packageDirectory, "package.json"), "utf8")
  );
  const sdkPackageJson = JSON.parse(
    await readFile(resolve(sdkDirectory, "package.json"), "utf8")
  );
  const sdkTarball = await findTarball(
    tempDirectory,
    `migrate-sdk-${sdkPackageJson.version}`
  );
  const tuiTarball = await findTarball(
    tempDirectory,
    `migrate-sdk-tui-${packageJson.version}`
  );
  await writeFile(
    resolve(fixtureDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "migrate-tui-package-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@migrate-sdk/tui": `file:${tuiTarball}`,
          effect: require("effect/package.json").version,
          "migrate-sdk": `file:${sdkTarball}`,
        },
      },
      null,
      2
    )}\n`
  );
  await copyFile(
    resolve(packageDirectory, "examples/packaging.config.ts"),
    resolve(fixtureDirectory, "migrate.config.ts")
  );

  run(pnpm, ["install", "--ignore-scripts"], { cwd: fixtureDirectory });

  const command = resolve(
    fixtureDirectory,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "migrate-tui.cmd" : "migrate-tui"
  );
  const version = run(command, ["--version"], {
    capture: true,
    cwd: fixtureDirectory,
  }).trim();
  const help = run(command, ["--help"], {
    capture: true,
    cwd: fixtureDirectory,
  });

  if (version !== packageJson.version) {
    throw new Error(
      `Packed launcher version ${version} did not match ${packageJson.version}`
    );
  }
  if (!(help.includes("Usage:") && help.includes("migrate-tui"))) {
    throw new Error("Packed launcher did not start the TUI application");
  }

  await runPackedMigration({ command, fixtureDirectory });

  process.stdout.write(
    `Packed launcher and consumer migration smoke check passed (${basename(tuiTarball)})\n`
  );
} finally {
  await rm(tempDirectory, { force: true, recursive: true });
}
