import { spawn } from "node:child_process";
import { existsSync, constants as fsConstants } from "node:fs";
import { access, open } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = require("../package.json");

const NATIVE_EXECUTABLE_MAGICS = new Set([
  "7f454c46", // ELF
  "4d5a", // PE/COFF
  "cafebabe", // Universal Mach-O
  "cefaedfe", // 32-bit Mach-O
  "cffaedfe", // 64-bit Mach-O
  "feedface", // 32-bit Mach-O, reverse byte order
  "feedfacf", // 64-bit Mach-O, reverse byte order
]);

const nativeExecutableExists = async (path) => {
  try {
    await access(
      path,
      process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK
    );
    const file = await open(path, "r");

    try {
      const header = Buffer.alloc(4);
      const { bytesRead } = await file.read(header, 0, header.byteLength, 0);
      const magic = header.subarray(0, bytesRead).toString("hex");

      return [...NATIVE_EXECUTABLE_MAGICS].some((prefix) =>
        magic.startsWith(prefix)
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
};

const linuxUsesMusl = (report = process.report?.getReport()) => {
  if (typeof report !== "object" || report === null || !("header" in report)) {
    return false;
  }

  const { header } = report;

  return (
    typeof header === "object" &&
    header !== null &&
    !("glibcVersionRuntime" in header)
  );
};

export const bunPlatformPackageCandidates = ({
  arch = process.arch,
  platform = process.platform,
  report,
} = {}) => {
  if (platform === "darwin" && arch === "arm64") {
    return ["@oven/bun-darwin-aarch64"];
  }
  if (platform === "darwin" && arch === "x64") {
    return ["@oven/bun-darwin-x64-baseline", "@oven/bun-darwin-x64"];
  }
  if (platform === "linux" && arch === "arm64") {
    return [
      linuxUsesMusl(report)
        ? "@oven/bun-linux-aarch64-musl"
        : "@oven/bun-linux-aarch64",
    ];
  }
  if (platform === "linux" && arch === "x64") {
    return linuxUsesMusl(report)
      ? ["@oven/bun-linux-x64-musl-baseline", "@oven/bun-linux-x64-musl"]
      : ["@oven/bun-linux-x64-baseline", "@oven/bun-linux-x64"];
  }
  if (platform === "win32" && arch === "arm64") {
    return ["@oven/bun-windows-aarch64"];
  }
  if (platform === "win32" && arch === "x64") {
    return ["@oven/bun-windows-x64-baseline", "@oven/bun-windows-x64"];
  }

  throw new Error(
    `Unsupported platform for Migrate TUI: ${platform}-${arch}. ` +
      "Supported platforms are macOS, Linux, and Windows on arm64 or x64."
  );
};

export const resolveBunExecutable = async () => {
  const bunPackageJsonPath = require.resolve("bun/package.json");
  const bunPackageDirectory = dirname(bunPackageJsonPath);
  const installedExecutable = join(bunPackageDirectory, "bin", "bun.exe");

  if (await nativeExecutableExists(installedExecutable)) {
    return installedExecutable;
  }

  const requireFromBun = createRequire(bunPackageJsonPath);
  const executableName = process.platform === "win32" ? "bun.exe" : "bun";

  for (const packageName of bunPlatformPackageCandidates()) {
    try {
      const platformPackageJsonPath = requireFromBun.resolve(
        `${packageName}/package.json`
      );
      const executable = join(
        dirname(platformPackageJsonPath),
        "bin",
        executableName
      );

      if (await nativeExecutableExists(executable)) {
        return executable;
      }
    } catch {
      // Try the next compatible platform package.
    }
  }

  throw new Error(
    "The Bun runtime for this platform is unavailable. Reinstall " +
      "@migrate-sdk/tui with optional dependencies enabled."
  );
};

const appEntryPath = () => {
  const compiled = join(packageDirectory, "dist", "bin.js");

  if (existsSync(compiled)) {
    return compiled;
  }

  const source = join(packageDirectory, "src", "bin.tsx");

  if (existsSync(source)) {
    return source;
  }

  throw new Error(
    "The Migrate TUI application entry point is missing. Reinstall the package."
  );
};

const signalExitCode = (signal) => {
  const signalNumber = osConstants.signals[signal];
  return signalNumber === undefined ? 1 : 128 + signalNumber;
};

export const tuiChildEnvironment = (env, nodeExecutable) => ({
  ...env,
  MIGRATE_TUI_NODE_EXECUTABLE: nodeExecutable,
});

export const launch = async (
  args,
  { cwd = process.cwd(), env = process.env, spawnProcess = spawn } = {}
) => {
  const executable = await resolveBunExecutable();
  const child = spawnProcess(executable, [appEntryPath(), ...args], {
    cwd,
    env: tuiChildEnvironment(env, process.execPath),
    stdio: "inherit",
  });
  const forwardedSignals = ["SIGINT", "SIGHUP", "SIGTERM"];
  const listeners = new Map();

  for (const signal of forwardedSignals) {
    const listener = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };

    listeners.set(signal, listener);
    process.once(signal, listener);
  }

  return await new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      for (const [signal, listener] of listeners) {
        process.off(signal, listener);
      }
    };

    child.once("error", (cause) => {
      cleanup();
      reject(cause);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolvePromise(code ?? (signal === null ? 1 : signalExitCode(signal)));
    });
  });
};

export const main = async (args = process.argv.slice(2)) => {
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }

  return await launch(args);
};
