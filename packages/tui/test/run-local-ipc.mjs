import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bunPackageDirectory = dirname(require.resolve("bun/package.json"));
const bunExecutable = join(bunPackageDirectory, "bin", "bun.exe");
const vitestPackageDirectory = dirname(require.resolve("vitest/package.json"));
const vitestExecutable = join(vitestPackageDirectory, "vitest.mjs");
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const bunSmokeFile = "test/fixtures/bun-local-ipc-smoke.ts";
const testFile = "test/local-ipc.test.ts";
const bunSmokeTimeoutMs = 20_000;
const behaviorSuiteTimeoutMs = 180_000;

const run = (executable, arguments_, timeout) =>
  spawnSync(executable, arguments_, {
    cwd: packageDirectory,
    stdio: "inherit",
    timeout,
    windowsHide: true,
  });

class IpcProcessError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const assertProcessSucceeded = (result, context) => {
  if (result.error !== undefined) {
    throw new IpcProcessError(`${context}: ${result.error.message}`, 1);
  }
  if (result.status !== 0) {
    const signalMessage =
      result.signal === null ? "" : ` from signal ${result.signal}`;
    throw new IpcProcessError(
      `${context}: process exited${signalMessage}`,
      result.status ?? 1
    );
  }
};

const runIpcTests = () => {
  assertProcessSucceeded(
    run(bunExecutable, [bunSmokeFile], bunSmokeTimeoutMs),
    "Bun-to-Node IPC smoke failed"
  );
  console.log("Bun-to-Node IPC smoke passed");
  assertProcessSucceeded(
    run(
      process.execPath,
      [vitestExecutable, "run", "--config", "vitest.ipc.config.ts", testFile],
      behaviorSuiteTimeoutMs
    ),
    "IPC behavior suite failed"
  );
};

try {
  runIpcTests();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = cause instanceof IpcProcessError ? cause.exitCode : 1;
}
