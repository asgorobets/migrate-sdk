import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Effect } from "effect";
import { toMigrationDefinitionId } from "migrate-sdk";
import type { MigrateConnection } from "migrate-sdk/client/node";
import {
  connectLocalMigrateServerForTesting,
  localMigrateServerEndpoint,
} from "migrate-sdk/client/node/testing";
import { MIGRATE_PROTOCOL_VERSION } from "migrate-sdk/protocol";
import { makeMigrationTuiRuntime } from "../src/index.ts";
import { makeMigrationTuiRuntimeWithLocalConnection } from "../src/server/tui-runtime.ts";
import { makeMigrationTuiRuntimeForTesting } from "./support/tui-runtime.ts";

const LOCK_ERROR_PATTERN = /lock/i;
const LIVE_DASHBOARD_READ_TIMEOUT_MS =
  process.platform === "win32" ? 2500 : 1000;
const incompatibleProtocolMessage = `Migrate Protocol version ${MIGRATE_PROTOCOL_VERSION + 1} is not supported`;
const serverFixtureUrl = new URL(
  "../../migrate-sdk/test/fixtures/server/",
  import.meta.url
);
const serverFixturePath = (fileName: string): string =>
  fileURLToPath(new URL(fileName, serverFixtureUrl));

const within = <Value>(promise: Promise<Value>, milliseconds: number) =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`Operation exceeded ${milliseconds}ms`)),
        milliseconds
      );
    }),
  ]);

const readFixtureToken = async (path: string): Promise<string | null> => {
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

const waitForFixtureToken = async (
  path: string,
  token: string,
  timeoutMs: number
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while ((await readFixtureToken(path)) !== token) {
    if (Date.now() >= deadline) {
      throw new Error(`Fixture marker was not written within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const writeFixtureStopRequest = async (
  path: string,
  token: string
): Promise<void> => {
  const temporaryPath = `${path}.${token}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ token }), "utf8");
  await rename(temporaryPath, path);
};

const processIsRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException & { readonly errno?: number };

    if (
      (typeof cause === "object" && cause !== null && error.code === "ESRCH") ||
      error.errno === 3
    ) {
      return false;
    }
    throw cause;
  }
};

const waitForProcessExit = async (
  pid: number,
  timeoutMs: number
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (processIsRunning(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Process ${pid} did not exit within ${timeoutMs}ms`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
};

const waitForPath = async (path: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error(`Path was not created within ${timeoutMs}ms: ${path}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
};

const readProcessId = async (path: string): Promise<number> => {
  await waitForPath(path, 5000);
  const pid = Number(await readFile(path, "utf8"));

  if (!(Number.isSafeInteger(pid) && pid > 0)) {
    throw new Error(`Invalid process id in ${path}`);
  }

  return pid;
};

const terminateProcess = async (pid: number | undefined): Promise<void> => {
  if (pid === undefined || !processIsRunning(pid)) {
    return;
  }

  process.kill(pid, "SIGKILL");
  await waitForProcessExit(pid, 5000);
};

test("Bun operates a Node-only migration through local Effect RPC", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: resolve("test/fixtures/node-only.config.ts"),
    cwd: process.cwd(),
  });

  try {
    expect(runtime.rows.map((row) => row.entry.id)).toEqual([
      "packaging-fixture",
    ]);

    const operation = await runtime.prepare(
      {
        definitionIds: [toMigrationDefinitionId("packaging-fixture")],
        kind: "definitions",
      },
      "run"
    );
    const reference = await runtime.start(operation);
    const result = await runtime.observeRun(reference.runId);

    expect(result.message).toContain("succeeded");
    expect((await runtime.refresh()).rows[0]?.status?.durable.migrated).toBe(1);
  } finally {
    await runtime.dispose?.();
  }
}, 20_000);

test("local commands use short-lived connections", async () => {
  const serverIdentity = `tui-command-connections-${randomUUID()}`;
  let connectionCount = 0;
  let disposalCount = 0;
  const runtime = await makeMigrationTuiRuntimeWithLocalConnection(
    {
      configPath: serverFixturePath("cancellation.config.ts"),
      cwd: resolve("../.."),
    },
    (input) => {
      connectionCount += 1;
      return connectLocalMigrateServerForTesting(input, {
        serverIdentity,
      }).then((connection) => ({
        ...connection,
        dispose: async () => {
          disposalCount += 1;
          await connection.dispose();
        },
      }));
    }
  );

  try {
    expect(connectionCount).toBe(1);
    expect(disposalCount).toBe(0);
    await runtime.refresh();
    expect(connectionCount).toBe(2);
    expect(disposalCount).toBe(1);
    await runtime.listActiveRuns();
    expect(connectionCount).toBe(3);
    expect(disposalCount).toBe(2);
  } finally {
    await runtime.dispose?.();
  }
  expect(disposalCount).toBe(3);
}, 20_000);

test("runtime disposal aborts and drains active local commands", async () => {
  const serverIdentity = `tui-command-disposal-${randomUUID()}`;
  let connectionCount = 0;
  let commandDisposed = false;
  let resolveCommandStarted: (() => void) | undefined;
  const commandStarted = new Promise<void>((resolveStarted) => {
    resolveCommandStarted = resolveStarted;
  });
  const runtime = await makeMigrationTuiRuntimeWithLocalConnection(
    {
      configPath: serverFixturePath("cancellation.config.ts"),
      cwd: resolve("../.."),
    },
    (input) => {
      connectionCount += 1;
      const currentConnection = connectionCount;

      return connectLocalMigrateServerForTesting(input, {
        serverIdentity,
      }).then((connection) => {
        if (currentConnection !== 2) {
          return connection;
        }

        return {
          ...connection,
          dispose: async () => {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
            await connection.dispose();
            commandDisposed = true;
          },
          runPromise: <Value, CommandError>(
            _effect: Effect.Effect<Value, CommandError>,
            options?: { readonly signal?: AbortSignal }
          ): Promise<Value> => {
            resolveCommandStarted?.();

            return new Promise<Value>((_resolve, reject) => {
              const signal = options?.signal;

              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
        } satisfies MigrateConnection;
      });
    }
  );
  let disposed = false;

  try {
    const commandOutcome = runtime.refresh().then(
      () => "resolved" as const,
      () => "rejected" as const
    );
    await within(commandStarted, 5000);
    await runtime.dispose?.();
    disposed = true;

    expect(await commandOutcome).toBe("rejected");
    expect(commandDisposed).toBe(true);
  } finally {
    if (!disposed) {
      await runtime.dispose?.();
    }
  }
}, 20_000);

test("live dashboard observation does not block dashboard reads", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: serverFixturePath("cancellation.config.ts"),
    cwd: resolve("../.."),
  });
  const controller = new AbortController();
  let observationSettled = Promise.resolve();

  try {
    let resolveFirstSnapshot: (() => void) | undefined;
    const firstSnapshot = new Promise<void>((resolveSnapshot) => {
      resolveFirstSnapshot = resolveSnapshot;
    });
    const observation = runtime.observeDashboard({
      onSnapshot: () => resolveFirstSnapshot?.(),
      signal: controller.signal,
    });
    observationSettled = observation.then(
      () => undefined,
      () => undefined
    );

    await within(firstSnapshot, LIVE_DASHBOARD_READ_TIMEOUT_MS);
    await expect(
      within(runtime.refresh(), LIVE_DASHBOARD_READ_TIMEOUT_MS)
    ).resolves.toBeDefined();
  } finally {
    controller.abort();
    await runtime.dispose?.();
    await observationSettled;
  }
}, 20_000);

test("live observation does not block dashboard reads or explicit cancellation", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: serverFixturePath("cancellation.config.ts"),
    cwd: resolve("src"),
  });
  let observationSettled = Promise.resolve();

  try {
    const operation = await runtime.prepare(
      {
        definitionIds: [toMigrationDefinitionId("cancellable")],
        kind: "definitions",
      },
      "run"
    );
    const reference = await runtime.start(operation);
    const execution = runtime.observeRun(reference.runId);
    observationSettled = execution.then(
      () => undefined,
      () => undefined
    );

    await expect(
      within(runtime.refresh(), LIVE_DASHBOARD_READ_TIMEOUT_MS)
    ).resolves.toBeDefined();
    await expect(runtime.stopRun(reference.runId)).resolves.toMatchObject({
      kind: "requested",
    });
    await expect(execution).resolves.toMatchObject({
      message: expect.stringContaining("cancelled"),
    });
  } finally {
    await runtime.dispose?.();
    await observationSettled;
  }
}, 20_000);

test("an inline run survives client exit and is observed by a fresh TUI", async () => {
  let firstRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;
  let secondRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;

  try {
    const configPath = serverFixturePath("cancellation.config.ts");
    firstRuntime = await makeMigrationTuiRuntime({
      configPath,
      cwd: resolve("test"),
    });
    const operation = await firstRuntime.prepare(
      {
        definitionIds: [toMigrationDefinitionId("cancellable")],
        kind: "definitions",
      },
      "run"
    );
    const reference = await firstRuntime.start(operation);
    const firstObservation = firstRuntime.observeRun(reference.runId);
    await expect(firstRuntime.detachForExit()).resolves.toMatchObject({
      kind: "detached",
    });
    const detached = await firstObservation;
    await firstRuntime.dispose?.();
    firstRuntime = undefined;

    secondRuntime = await makeMigrationTuiRuntime({
      configPath,
      cwd: resolve("test"),
    });
    expect(await secondRuntime.listActiveRuns()).toEqual([
      expect.objectContaining({
        runId: detached.runId,
        status: "running",
        stopSupported: true,
      }),
    ]);
    await expect(
      within(secondRuntime.observeRun(detached.runId), 5000)
    ).resolves.toEqual({
      message: `Run ${detached.runId} succeeded`,
      outcome: "completed",
      runId: detached.runId,
    });
  } finally {
    await firstRuntime?.dispose?.();
    await secondRuntime?.dispose?.();
  }
}, 20_000);

test("reconnects to concurrent runs and stops only the selected run", async () => {
  const configPath = resolve("test/fixtures/concurrent-runs.config.ts");
  let firstRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;
  let secondRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;

  try {
    firstRuntime = await makeMigrationTuiRuntime({
      configPath,
      cwd: process.cwd(),
    });
    const [authorsOperation, booksOperation] = await Promise.all([
      firstRuntime.prepare(
        {
          definitionIds: [toMigrationDefinitionId("authors")],
          kind: "definitions",
        },
        "run"
      ),
      firstRuntime.prepare(
        {
          definitionIds: [toMigrationDefinitionId("books")],
          kind: "definitions",
        },
        "run"
      ),
    ]);
    const [authorsRun, booksRun] = await Promise.all([
      firstRuntime.start(authorsOperation),
      firstRuntime.start(booksOperation),
    ]);
    await firstRuntime.dispose?.();
    firstRuntime = undefined;

    secondRuntime = await makeMigrationTuiRuntime({
      configPath,
      cwd: process.cwd(),
    });
    const activeRuns = await secondRuntime.listActiveRuns();

    expect(activeRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          definitionIds: ["authors"],
          runId: authorsRun.runId,
          stopSupported: true,
        }),
        expect.objectContaining({
          definitionIds: ["books"],
          runId: booksRun.runId,
          stopSupported: true,
        }),
      ])
    );
    await expect(
      secondRuntime.stopRun(authorsRun.runId)
    ).resolves.toMatchObject({
      kind: "requested",
      runId: authorsRun.runId,
    });
    await expect(
      secondRuntime.observeRun(authorsRun.runId)
    ).resolves.toMatchObject({
      outcome: "cancelled",
      runId: authorsRun.runId,
    });
    await expect(
      within(secondRuntime.observeRun(booksRun.runId), 5000)
    ).resolves.toMatchObject({
      outcome: "completed",
      runId: booksRun.runId,
    });
  } finally {
    await firstRuntime?.dispose?.();
    await secondRuntime?.dispose?.();
  }
}, 20_000);

test("definition locks reject an overlapping run without stopping its owner", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: resolve("test/fixtures/concurrent-runs.config.ts"),
    cwd: process.cwd(),
  });

  try {
    const target = {
      definitionIds: [toMigrationDefinitionId("locked")],
      kind: "definitions" as const,
    };
    const firstRun = await runtime.start(await runtime.prepare(target, "run"));
    const overlappingOperation = await runtime.prepare(target, "run");

    await expect(runtime.start(overlappingOperation)).rejects.toThrow(
      LOCK_ERROR_PATTERN
    );
    expect(await runtime.listActiveRuns()).toEqual([
      expect.objectContaining({
        definitionIds: ["locked"],
        runId: firstRun.runId,
        stopSupported: true,
      }),
    ]);
    await expect(runtime.stopRun(firstRun.runId)).resolves.toMatchObject({
      kind: "requested",
      runId: firstRun.runId,
    });
    await expect(runtime.observeRun(firstRun.runId)).resolves.toMatchObject({
      outcome: "cancelled",
      runId: firstRun.runId,
    });
  } finally {
    await runtime.dispose?.();
  }
}, 20_000);

test("stops a selected server-owned run by migration run id", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: serverFixturePath("cancellation.config.ts"),
    cwd: resolve("examples"),
  });
  try {
    const operation = await runtime.prepare(
      {
        definitionIds: [toMigrationDefinitionId("cancellable")],
        kind: "definitions",
      },
      "run"
    );
    const reference = await runtime.start(operation);
    const execution = runtime.observeRun(reference.runId);
    const [activeRun] = await runtime.listActiveRuns();

    expect(activeRun?.stopSupported).toBe(true);
    if (activeRun === undefined) {
      throw new Error("Expected an active server-owned run");
    }
    await expect(runtime.stopRun(activeRun.runId)).resolves.toMatchObject({
      kind: "requested",
      runId: activeRun.runId,
    });
    await expect(execution).resolves.toMatchObject({ outcome: "cancelled" });
  } finally {
    await runtime.dispose?.();
  }
}, 20_000);

test("reattaches to a detached run through the public run id", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: serverFixturePath("detached-live-progress.config.ts"),
    cwd: process.cwd(),
  });
  try {
    const operation = await runtime.prepare(
      {
        definitionIds: [toMigrationDefinitionId("live-progress")],
        kind: "definitions",
      },
      "run"
    );
    const reference = await runtime.start(operation);
    const firstObservation = runtime.observeRun(reference.runId);
    await expect(runtime.detachForExit()).resolves.toMatchObject({
      kind: "detached",
    });
    const detached = await firstObservation;

    expect(await runtime.listActiveRuns()).toEqual([
      expect.objectContaining({
        runId: detached.runId,
        status: "running",
      }),
    ]);
    const secondObservation = runtime.observeRun(detached.runId);
    await expect(runtime.detachForExit()).resolves.toMatchObject({
      kind: "detached",
    });
    await expect(secondObservation).resolves.toEqual({
      message: `Run ${detached.runId} continues in the background`,
      outcome: "detached",
      runId: detached.runId,
    });
    expect(await runtime.listActiveRuns()).toEqual([
      expect.objectContaining({ runId: detached.runId }),
    ]);
    await expect(runtime.observeRun(detached.runId)).resolves.toEqual({
      message: `Run ${detached.runId} succeeded`,
      outcome: "completed",
      runId: detached.runId,
    });
  } finally {
    await runtime.dispose?.();
  }
}, 20_000);

test("reattaches through a fresh Node server using persistent run state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migrate-tui-reconnect-"));
  const previousDirectory = process.env.MIGRATE_TUI_RECONNECT_FIXTURE_DIR;
  const previousServerPidPath =
    process.env.MIGRATE_TUI_RECONNECT_SERVER_PID_PATH;
  const previousToken = process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN;
  const fixtureToken = randomUUID();
  const serverPidPath = join(directory, "server.pid");
  const serverEntry = new URL(
    "./fixtures/recording-server-entry.ts",
    import.meta.url
  );
  process.env.MIGRATE_TUI_RECONNECT_FIXTURE_DIR = directory;
  process.env.MIGRATE_TUI_RECONNECT_SERVER_PID_PATH = serverPidPath;
  process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN = fixtureToken;
  let firstServerPid: number | undefined;
  let secondServerPid: number | undefined;
  let firstRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;
  let secondRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;

  try {
    const configPath = resolve("test/fixtures/persistent-reconnect.config.ts");
    firstRuntime = await makeMigrationTuiRuntimeForTesting(
      {
        configPath,
        cwd: process.cwd(),
      },
      { serverEntry }
    );
    firstServerPid = await readProcessId(serverPidPath);
    const operation = await firstRuntime.prepare(
      {
        definitionIds: [toMigrationDefinitionId("persistent-reconnect")],
        kind: "definitions",
      },
      "run"
    );
    const reference = await firstRuntime.start(operation);
    const firstObservation = firstRuntime.observeRun(reference.runId);
    await expect(firstRuntime.detachForExit()).resolves.toMatchObject({
      kind: "detached",
    });
    const detached = await firstObservation;
    await firstRuntime.dispose?.();
    firstRuntime = undefined;
    await terminateProcess(firstServerPid);
    await unlink(serverPidPath);

    secondRuntime = await makeMigrationTuiRuntimeForTesting(
      {
        configPath,
        cwd: process.cwd(),
      },
      { serverEntry }
    );
    secondServerPid = await readProcessId(serverPidPath);
    expect(secondServerPid).not.toBe(firstServerPid);
    expect(await secondRuntime.listActiveRuns()).toEqual([
      expect.objectContaining({
        observationDefinitionId: "persistent-reconnect",
        runId: detached.runId,
      }),
    ]);
    await expect(
      within(secondRuntime.observeRun(detached.runId), 10_000)
    ).resolves.toEqual({
      message: `Run ${detached.runId} succeeded`,
      outcome: "completed",
      runId: detached.runId,
    });
  } finally {
    await firstRuntime?.dispose?.();
    await secondRuntime?.dispose?.();
    await terminateProcess(firstServerPid);
    await terminateProcess(secondServerPid);

    try {
      const startedToken = await readFixtureToken(
        join(directory, "execution-started.json")
      );

      if (startedToken === fixtureToken) {
        await writeFixtureStopRequest(
          join(directory, "execution-stop.json"),
          fixtureToken
        );
        await waitForFixtureToken(
          join(directory, "execution-exited.json"),
          fixtureToken,
          5000
        );
      }
    } finally {
      if (previousDirectory === undefined) {
        delete process.env.MIGRATE_TUI_RECONNECT_FIXTURE_DIR;
      } else {
        process.env.MIGRATE_TUI_RECONNECT_FIXTURE_DIR = previousDirectory;
      }
      if (previousServerPidPath === undefined) {
        delete process.env.MIGRATE_TUI_RECONNECT_SERVER_PID_PATH;
      } else {
        process.env.MIGRATE_TUI_RECONNECT_SERVER_PID_PATH =
          previousServerPidPath;
      }
      if (previousToken === undefined) {
        delete process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN;
      } else {
        process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN = previousToken;
      }
    }

    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);

test("Node server bootstrap failures exit unsuccessfully", () => {
  const result = spawnSync(
    process.env.MIGRATE_TUI_NODE_EXECUTABLE ?? "node",
    [
      fileURLToPath(
        new URL(
          "../../migrate-sdk/src/client/node/local-server-entry.ts",
          import.meta.url
        )
      ),
      "--cwd",
      process.cwd(),
      "--config",
      resolve("test/fixtures/missing.config.ts"),
      "--socket",
      join(tmpdir(), `migrate-bootstrap-${randomUUID()}.sock`),
    ],
    { encoding: "utf8" }
  );

  expect(result.status).toBe(1);
  expect(`${result.stdout}${result.stderr}`).toContain(
    "Migration config file was not found"
  );
});

test("reports a local server startup timeout and releases the child", async () => {
  await expect(
    connectLocalMigrateServerForTesting(
      { cwd: process.cwd() },
      {
        serverEntry: new URL("./fixtures/hanging-server.ts", import.meta.url),
        startupTimeoutMs: 50,
      }
    )
  ).rejects.toThrow("Unable to connect to the local Migrate Server");
});

test("a persistent startup timeout terminates the server started by the launcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migrate-tui-timeout-"));
  const markerPath = join(directory, "server.pid");
  const previousMarker = process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER;
  const serverIdentity = randomUUID();
  process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER = markerPath;
  let pid: number | undefined;

  try {
    await expect(
      connectLocalMigrateServerForTesting(
        {
          configPath: resolve("test/fixtures/hanging-config.ts"),
          cwd: process.cwd(),
        },
        {
          serverIdentity,
          startupTimeoutMs: 5000,
        }
      )
    ).rejects.toThrow("Unable to connect to the local Migrate Server");
    pid = await readProcessId(markerPath);

    await waitForProcessExit(pid, 1000);
  } finally {
    if (pid !== undefined && processIsRunning(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid, 1000);
    }
    if (previousMarker === undefined) {
      delete process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER;
    } else {
      process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER = previousMarker;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 10_000);

test("reports an invalid Node executable without crashing the TUI", async () => {
  const serverIdentity = randomUUID();

  await expect(
    connectLocalMigrateServerForTesting(
      {
        cwd: process.cwd(),
        nodeExecutable: join(tmpdir(), `missing-node-${randomUUID()}`),
      },
      {
        serverIdentity,
        startupTimeoutMs: 1000,
      }
    )
  ).rejects.toThrow("Unable to connect to the local Migrate Server");
});

const unixTest = process.platform === "win32" ? test.skip : test;

for (const variant of ["protocol", "malformed"] as const) {
  unixTest(
    `does not unlink a live server socket after ${variant} incompatibility`,
    async () => {
      const configPath = `incompatible-${variant}.config.ts`;
      const cwd = process.cwd();
      const socketPath = localMigrateServerEndpoint({ configPath, cwd });
      const child = spawn(
        process.env.MIGRATE_TUI_NODE_EXECUTABLE ?? "node",
        [
          fileURLToPath(
            new URL("./fixtures/socket-server-info.ts", import.meta.url)
          ),
          "--socket",
          socketPath,
          "--variant",
          variant,
        ],
        { cwd, stdio: "ignore" }
      );
      const childPid = child.pid;

      if (childPid === undefined) {
        throw new Error("Incompatible server fixture did not start");
      }

      try {
        await waitForPath(socketPath, 3000);
        await expect(
          connectLocalMigrateServerForTesting(
            { configPath, cwd },
            { startupTimeoutMs: 1000 }
          )
        ).rejects.toThrow(
          variant === "protocol"
            ? incompatibleProtocolMessage
            : "Unable to connect to the local Migrate Server"
        );

        expect(existsSync(socketPath)).toBe(true);
        expect(processIsRunning(childPid)).toBe(true);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolveExit) => {
            child.once("exit", () => resolveExit());
            child.kill("SIGKILL");
          });
        }
        await unlink(socketPath).catch(() => undefined);
      }
    },
    10_000
  );
}

test("reports when the socket server exits during startup", async () => {
  await expect(
    connectLocalMigrateServerForTesting(
      { cwd: process.cwd() },
      {
        serverEntry: new URL("./fixtures/crashing-server.ts", import.meta.url),
        startupTimeoutMs: 2000,
      }
    )
  ).rejects.toThrow("exited before startup completed");
});

test.each([
  [undefined, incompatibleProtocolMessage],
  ["sdk", "Migrate SDK version 999.0.0 is not supported"],
  ["malformed", "Unable to connect to the local Migrate Server"],
] as const)("rejects incompatible server info (%s)", async (configPath, message) => {
  await expect(
    connectLocalMigrateServerForTesting(
      {
        ...(configPath === undefined ? {} : { configPath }),
        cwd: process.cwd(),
      },
      {
        serverEntry: new URL(
          "./fixtures/socket-server-info.ts",
          import.meta.url
        ),
        startupTimeoutMs: 2000,
      }
    )
  ).rejects.toThrow(message);
});
