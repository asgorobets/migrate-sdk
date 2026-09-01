import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { MigrationExecutable } from "migrate-sdk";
import {
  makePersistentReconnectRegistry,
  reconnectFixtureDirectory,
  reconnectFixturePaths,
  reconnectFixtureToken,
} from "./persistent-reconnect-support.ts";

const writeJson = async (path: string, value: unknown): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), "utf8");
  await rename(temporaryPath, path);
};

const readStopToken = async (path: string): Promise<string | null> => {
  try {
    const marker = JSON.parse(await readFile(path, "utf8")) as {
      readonly token?: string;
    };
    return marker.token ?? null;
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw cause;
  }
};

const waitForStopRequest = async (
  path: string,
  token: string,
  signal: AbortSignal
): Promise<boolean> => {
  while (!signal.aborted) {
    if ((await readStopToken(path)) === token) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return false;
};

const main = async () => {
  const directory = reconnectFixtureDirectory();
  const token = reconnectFixtureToken();
  const paths = reconnectFixturePaths(directory);
  await mkdir(directory, { recursive: true });
  try {
    const registry = makePersistentReconnectRegistry(directory);
    const plan = await Effect.runPromise(
      registry.executable().planRun({ all: true })
    );
    const result = await Effect.runPromise(
      MigrationExecutable.inlineService.startRun(plan)
    );

    await writeJson(paths.started, {
      pid: process.pid,
      runId: result.runId,
      token,
    });

    if (result.kind === "completed" || result.handle === undefined) {
      await writeJson(paths.terminal, {
        runId: result.runId,
        status: result.kind === "completed" ? result.summary.status : "failed",
        token,
      });
      return;
    }

    const handle = result.handle;
    const stopMonitor = new AbortController();
    const stopRequest = waitForStopRequest(
      paths.stop,
      token,
      stopMonitor.signal
    ).then(async (requested) => {
      if (requested) {
        await Effect.runPromise(handle.cancel);
      }
    });

    try {
      const terminal = await Effect.runPromise(handle.wait);
      let status: "cancelled" | "failed" | "succeeded";

      if (terminal.kind === "cancelled") {
        status = "cancelled";
      } else if (terminal.kind === "execution-failed") {
        status = "failed";
      } else {
        status = terminal.summary.status;
      }

      await writeJson(paths.terminal, {
        runId: result.runId,
        status,
        token,
      });
    } finally {
      stopMonitor.abort();
      await stopRequest;
    }
  } finally {
    await writeJson(paths.exited, { pid: process.pid, token });
  }
};

await main();
