import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import {
  MigrationExecutable,
  MigrationStore,
  toMigrationRunId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import {
  makePersistentReconnectRegistry,
  reconnectFixtureDirectory,
  reconnectFixturePaths,
  reconnectFixtureToken,
} from "./persistent-reconnect-support.ts";

interface ExecutionMarker {
  readonly pid?: number;
  readonly runId: string;
  readonly status?: "cancelled" | "failed" | "succeeded";
  readonly token: string;
}

const readMarker = async (path: string): Promise<ExecutionMarker | null> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ExecutionMarker;
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

const waitForMarker = async (
  path: string,
  token: string
): Promise<ExecutionMarker> => {
  while (true) {
    const marker = await readMarker(path);

    if (marker?.token === token) {
      return marker;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const directory = reconnectFixtureDirectory();
const token = reconnectFixtureToken();
const paths = reconnectFixturePaths(directory);
const registry = makePersistentReconnectRegistry(directory);
const executableLayer = Layer.succeed(MigrationExecutable, {
  startRollback: MigrationExecutable.inlineService.startRollback,
  startRun: (plan) =>
    Effect.tryPromise({
      catch: (cause) => ({ _tag: "PersistentReconnectStartError", cause }),
      try: async () => {
        await Promise.all([
          rm(paths.exited, { force: true }),
          rm(paths.started, { force: true }),
          rm(paths.stop, { force: true }),
          rm(paths.terminal, { force: true }),
        ]);
        const worker = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("./persistent-reconnect-worker.ts", import.meta.url)
            ),
          ],
          {
            detached: true,
            env: process.env,
            stdio: "ignore",
          }
        );
        worker.unref();
        const started = await waitForMarker(paths.started, token);
        const runId = toMigrationRunId(started.runId);
        const definition = plan.definitions[0];

        if (definition === undefined) {
          throw new Error("Persistent reconnect run requires one definition");
        }

        const execution = {
          adapter: "persistent-process-fixture",
          executionId: `process:${token}:${runId}`,
        };
        await Effect.runPromise(
          MigrationStore.pipe(
            Effect.flatMap((store) =>
              store.attachRunExecution(
                runId,
                plan.executionDefinitionIds,
                execution
              )
            ),
            Effect.provide(definition.store)
          )
        );

        return { execution, kind: "started" as const, runId };
      },
    }),
  waitForExecution: (execution) =>
    Effect.tryPromise({
      catch: (cause) => ({
        _tag: "PersistentReconnectObservationError",
        cause,
      }),
      try: async () => {
        if (execution.adapter !== "persistent-process-fixture") {
          return { kind: "failed" as const };
        }

        const terminal = await waitForMarker(paths.terminal, token);

        if (terminal.status === "succeeded") {
          return { kind: "succeeded" as const };
        }
        if (terminal.status === "cancelled") {
          return { kind: "cancelled" as const };
        }
        return { kind: "failed" as const };
      },
    }),
});

export default defineMigrationCliConfig({ executableLayer, registry });
