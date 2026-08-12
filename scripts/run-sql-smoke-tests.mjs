import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const composeArgs = ["compose", "--file", "compose.sql-smoke.yml"];
let activeChild;
let receivedSignal;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    activeChild = child;

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (activeChild === child) {
        activeChild = undefined;
      }

      if (code === 0) {
        resolve();
        return;
      }

      const outcome =
        signal === null
          ? `exited with status ${String(code)}`
          : `received ${signal}`;
      reject(new Error(`${command} ${outcome}`));
    });
  });
}

function cleanup() {
  return run("docker", [
    ...composeArgs,
    "down",
    "--remove-orphans",
    "--volumes",
  ]);
}

async function logContainers() {
  try {
    await run("docker", [...composeArgs, "logs", "--no-color"]);
  } catch {
    // Preserve the original startup failure.
  }
}

async function pullMissingImages() {
  for (const service of ["postgres", "mysql", "sqlserver"]) {
    await run("docker", [
      ...composeArgs,
      "pull",
      "--policy",
      "missing",
      service,
    ]);
  }
}

function handleSignal(signal) {
  receivedSignal ??= signal;
  activeChild?.kill(signal);
}

const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");

process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

let failure;
try {
  await cleanup();
  await run("pnpm", ["--filter", "migrate-sdk", "build"]);
  await pullMissingImages();
  try {
    await run("docker", [
      ...composeArgs,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "300",
    ]);
  } catch (error) {
    await logContainers();
    throw error;
  }
  await run("pnpm", ["--filter", "migrate-sdk", "test:sql:smoke"]);
} catch (error) {
  failure = error;
}

try {
  await cleanup();
} catch (error) {
  failure ??= error;
}

process.removeListener("SIGINT", onSigint);
process.removeListener("SIGTERM", onSigterm);

if (receivedSignal !== undefined) {
  process.kill(process.pid, receivedSignal);
}

if (failure !== undefined) {
  throw failure;
}
