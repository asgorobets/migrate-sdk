import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeArgs = ["compose", "--file", "compose.sql-smoke.yml"];

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${String(result.status)}`);
  }
}

function cleanup() {
  run("docker", [...composeArgs, "down", "--remove-orphans", "--volumes"]);
}

function logContainers() {
  try {
    run("docker", [...composeArgs, "logs", "--no-color"]);
  } catch {
    // Preserve the original startup failure.
  }
}

function pullMissingImages() {
  for (const service of ["postgres", "mysql", "sqlserver"]) {
    run("docker", [...composeArgs, "pull", "--policy", "missing", service]);
  }
}

let failure;
try {
  cleanup();
  pullMissingImages();
  try {
    run("docker", [
      ...composeArgs,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "300",
    ]);
  } catch (error) {
    logContainers();
    throw error;
  }
  run("pnpm", ["--filter", "migrate-sdk", "test:sql:smoke"]);
} catch (error) {
  failure = error;
}

try {
  cleanup();
} catch (error) {
  failure ??= error;
}

if (failure !== undefined) {
  throw failure;
}
