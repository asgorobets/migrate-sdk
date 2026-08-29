import nextEnv from "@next/env";
import {
  TUI_SANDBOX_PNPM_HOME,
  TUI_SANDBOX_PNPM_PATH,
  TUI_SANDBOX_WORKSPACE_CWD,
} from "./tui-sandbox-runtime";

nextEnv.loadEnvConfig(process.cwd());

const { Sandbox } = await import("@vercel/sandbox");

const SNAPSHOT_BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;
const repositoryUrl =
  process.env.MIGRATE_TUI_REPOSITORY_URL?.trim() ||
  "https://github.com/asgorobets/migrate-sdk.git";
const repositoryRevision =
  process.env.MIGRATE_TUI_REPOSITORY_REVISION?.trim() || "main";

const sandbox = await Sandbox.create({
  persistent: true,
  resources: { vcpus: 2 },
  tags: { purpose: "migrate-tui-snapshot" },
  timeout: SNAPSHOT_BUILD_TIMEOUT_MS,
});

interface RunOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const run = async (
  command: string,
  args: readonly string[],
  options: RunOptions = {}
): Promise<void> => {
  const result = await sandbox.runCommand({
    args: [...args],
    cmd: command,
    cwd: options.cwd ?? TUI_SANDBOX_WORKSPACE_CWD,
    env: { ...options.env },
    stderr: process.stderr,
    stdout: process.stdout,
    timeoutMs: SNAPSHOT_BUILD_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command} exited with code ${result.exitCode}`);
  }
};

const readPinnedPnpmVersion = async (): Promise<string> => {
  const packageJson = await sandbox.readFileToBuffer({
    cwd: TUI_SANDBOX_WORKSPACE_CWD,
    path: "package.json",
  });
  if (!packageJson) {
    throw new Error(`No package.json found in ${TUI_SANDBOX_WORKSPACE_CWD}`);
  }

  const manifest: unknown = JSON.parse(packageJson.toString("utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("packageManager" in manifest) ||
    typeof manifest.packageManager !== "string" ||
    !manifest.packageManager.startsWith("pnpm@")
  ) {
    throw new Error("The repository must pin pnpm in package.json");
  }

  const [pnpmVersion] = manifest.packageManager
    .slice("pnpm@".length)
    .split("+", 1);
  if (!pnpmVersion) {
    throw new Error("The repository must pin a pnpm version in package.json");
  }
  return pnpmVersion;
};

try {
  await run("git", ["init", TUI_SANDBOX_WORKSPACE_CWD], { cwd: "/vercel" });
  await run("git", ["remote", "add", "origin", repositoryUrl]);
  await run("git", ["fetch", "--depth", "1", "origin", repositoryRevision]);
  await run("git", ["checkout", "--detach", "FETCH_HEAD"]);
  await run("test", ["-f", "pnpm-workspace.yaml"]);
  const pnpmVersion = await readPinnedPnpmVersion();
  const pnpmEnvironment = { PNPM_HOME: TUI_SANDBOX_PNPM_HOME };
  await run("npx", ["--yes", "get-pnpm", pnpmVersion], {
    env: pnpmEnvironment,
  });
  await run(TUI_SANDBOX_PNPM_PATH, ["install", "--frozen-lockfile"], {
    env: pnpmEnvironment,
  });
  await run(TUI_SANDBOX_PNPM_PATH, ["build-packages"], {
    env: pnpmEnvironment,
  });
  await run(
    TUI_SANDBOX_PNPM_PATH,
    ["--filter", "@migrate-sdk/tui", "dev", "--", "--version"],
    { env: pnpmEnvironment }
  );

  const snapshot = await sandbox.snapshot({
    expiration: SNAPSHOT_EXPIRATION_MS,
  });
  process.stdout.write(
    `\nMIGRATE_TUI_SANDBOX_SNAPSHOT_ID=${snapshot.snapshotId}\n`
  );
} catch (cause) {
  await sandbox.delete().catch(() => undefined);
  throw cause;
}
