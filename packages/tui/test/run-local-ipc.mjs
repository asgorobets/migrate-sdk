import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bunPackageDirectory = dirname(require.resolve("bun/package.json"));
const bunExecutable = join(bunPackageDirectory, "bin", "bun.exe");
const testFile = "test/local-ipc.test.ts";
const windowsBunCrashExitCode = 3;
const windowsBunCrashAttempts = 3;
const isolateTests =
  process.platform === "win32" ||
  process.env.MIGRATE_TUI_ISOLATE_IPC_TESTS === "1";

const runBun = (arguments_, options = {}) =>
  spawnSync(bunExecutable, arguments_, {
    cwd: dirname(dirname(fileURLToPath(import.meta.url))),
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });

class BunProcessError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const assertBunSucceeded = (result, context) => {
  if (result.error !== undefined) {
    throw new BunProcessError(`${context}: ${result.error.message}`, 1);
  }
  if (result.status !== 0) {
    const signalMessage =
      result.signal === null ? "" : ` from signal ${result.signal}`;
    throw new BunProcessError(
      `${context}: Bun exited${signalMessage}`,
      result.status ?? 1
    );
  }
};

const decodeXmlAttribute = (value) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const run = () => {
  if (!isolateTests) {
    assertBunSucceeded(runBun(["test", testFile]), "IPC test suite failed");
    return;
  }

  const manifestDirectory = mkdtempSync(join(tmpdir(), "migrate-tui-ipc-"));
  const manifestPath = join(manifestDirectory, "tests.xml");
  let testNames;

  try {
    const discovery = runBun([
      "test",
      testFile,
      "--test-name-pattern",
      "a^",
      "--reporter=junit",
      `--reporter-outfile=${manifestPath}`,
      "--pass-with-no-tests",
    ]);
    assertBunSucceeded(discovery, "Unable to discover IPC tests");

    const manifest = readFileSync(manifestPath, "utf8");
    testNames = Array.from(
      manifest.matchAll(/<testcase\b[^>]*\bname="([^"]*)"/g),
      (match) => decodeXmlAttribute(match[1])
    );
  } finally {
    rmSync(manifestDirectory, { force: true, recursive: true });
  }

  if (testNames.length === 0) {
    throw new Error("Bun did not report any IPC tests");
  }

  for (const [index, testName] of testNames.entries()) {
    console.log(
      `Windows IPC test ${index + 1}/${testNames.length}: ${testName}`
    );
    let result;

    for (let attempt = 1; attempt <= windowsBunCrashAttempts; attempt += 1) {
      result = runBun([
        "test",
        testFile,
        "--test-name-pattern",
        `^${escapeRegex(testName)}$`,
        "--only-failures",
        "--no-orphans",
      ]);
      if (
        process.platform !== "win32" ||
        result.status !== windowsBunCrashExitCode
      ) {
        break;
      }
      console.warn(
        `Bun crashed during ${testName} (attempt ${attempt}/${windowsBunCrashAttempts})`
      );
    }

    assertBunSucceeded(result, `IPC test failed: ${testName}`);
  }
};

try {
  run();
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = cause instanceof BunProcessError ? cause.exitCode : 1;
}
