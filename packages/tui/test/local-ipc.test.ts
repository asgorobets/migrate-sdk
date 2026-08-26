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
import { toMigrationDefinitionId } from "migrate-sdk";
import { MIGRATE_PROTOCOL_VERSION } from "migrate-sdk/protocol";
import { makeMigrationTuiRuntime } from "../src/index.ts";
import {
  connectLocalMigrateServer,
  localMigrateServerEndpoint,
} from "../src/server/local-client.ts";

const LOCK_ERROR_PATTERN = /lock/i;
const incompatibleProtocolMessage = `Migrate Protocol version ${MIGRATE_PROTOCOL_VERSION + 1} is not supported`;

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
        definitionId: toMigrationDefinitionId("packaging-fixture"),
        kind: "migration",
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

test("live observation does not block dashboard reads or explicit cancellation", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: resolve("examples/cancellation.config.ts"),
    cwd: resolve("src"),
  });
  try {
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("cancellable"),
        kind: "migration",
      },
      "run"
    );
    const reference = await runtime.start(operation);
    const execution = runtime.observeRun(reference.runId);

    await expect(within(runtime.refresh(), 1000)).resolves.toBeDefined();
    await expect(runtime.stopRun(reference.runId)).resolves.toMatchObject({
      kind: "requested",
    });
    await expect(execution).resolves.toMatchObject({
      message: expect.stringContaining("cancelled"),
    });
  } finally {
    await runtime.dispose?.();
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
    const configPath = resolve("examples/cancellation.config.ts");
    firstRuntime = await makeMigrationTuiRuntime({
      configPath,
      cwd: resolve("test"),
    });
    const operation = await firstRuntime.prepare(
      {
        definitionId: toMigrationDefinitionId("cancellable"),
        kind: "migration",
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
          definitionId: toMigrationDefinitionId("authors"),
          kind: "migration",
        },
        "run"
      ),
      firstRuntime.prepare(
        {
          definitionId: toMigrationDefinitionId("books"),
          kind: "migration",
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
      definitionId: toMigrationDefinitionId("locked"),
      kind: "migration" as const,
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
    configPath: resolve("examples/cancellation.config.ts"),
    cwd: resolve("examples"),
  });
  try {
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("cancellable"),
        kind: "migration",
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
    configPath: resolve("examples/detached-live-progress.config.ts"),
    cwd: process.cwd(),
  });
  try {
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("live-progress"),
        kind: "migration",
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
  const previousToken = process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN;
  const fixtureToken = randomUUID();
  process.env.MIGRATE_TUI_RECONNECT_FIXTURE_DIR = directory;
  process.env.MIGRATE_TUI_RECONNECT_FIXTURE_TOKEN = fixtureToken;
  let firstRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;
  let secondRuntime:
    | Awaited<ReturnType<typeof makeMigrationTuiRuntime>>
    | undefined;

  try {
    const configPath = resolve("test/fixtures/persistent-reconnect.config.ts");
    firstRuntime = await makeMigrationTuiRuntime({
      configPath,
      cwd: process.cwd(),
    });
    const operation = await firstRuntime.prepare(
      {
        definitionId: toMigrationDefinitionId("persistent-reconnect"),
        kind: "migration",
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
      cwd: process.cwd(),
    });
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
      fileURLToPath(new URL("../src/server/node-entry.ts", import.meta.url)),
      "--cwd",
      process.cwd(),
      "--config",
      resolve("test/fixtures/missing.config.ts"),
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
    connectLocalMigrateServer({
      cwd: process.cwd(),
      serverEntry: new URL("./fixtures/hanging-server.ts", import.meta.url),
      startupTimeoutMs: 50,
    })
  ).rejects.toThrow("Unable to connect to the local Migrate Server");
});

test("a persistent startup timeout terminates the server started by the launcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migrate-tui-timeout-"));
  const markerPath = join(directory, "server.pid");
  const previousMarker = process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER;
  const previousIdentity = process.env.MIGRATE_TUI_SERVER_IDENTITY;
  process.env.MIGRATE_TUI_HANGING_CONFIG_MARKER = markerPath;
  process.env.MIGRATE_TUI_SERVER_IDENTITY = randomUUID();
  let pid: number | undefined;

  try {
    await expect(
      connectLocalMigrateServer({
        configPath: resolve("test/fixtures/hanging-config.ts"),
        cwd: process.cwd(),
        startupTimeoutMs: 1000,
      })
    ).rejects.toThrow("Unable to connect to the local Migrate Server");
    pid = Number(await readFile(markerPath, "utf8"));

    await waitForProcessExit(pid, 500);
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
    if (previousIdentity === undefined) {
      delete process.env.MIGRATE_TUI_SERVER_IDENTITY;
    } else {
      process.env.MIGRATE_TUI_SERVER_IDENTITY = previousIdentity;
    }
    await rm(directory, { force: true, recursive: true });
  }
}, 10_000);

test("reports an invalid Node executable without crashing the TUI", async () => {
  const previousIdentity = process.env.MIGRATE_TUI_SERVER_IDENTITY;
  process.env.MIGRATE_TUI_SERVER_IDENTITY = randomUUID();

  try {
    await expect(
      connectLocalMigrateServer({
        cwd: process.cwd(),
        nodeExecutable: join(tmpdir(), `missing-node-${randomUUID()}`),
        startupTimeoutMs: 1000,
      })
    ).rejects.toThrow("Unable to connect to the local Migrate Server");
  } finally {
    if (previousIdentity === undefined) {
      delete process.env.MIGRATE_TUI_SERVER_IDENTITY;
    } else {
      process.env.MIGRATE_TUI_SERVER_IDENTITY = previousIdentity;
    }
  }
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
          connectLocalMigrateServer({
            configPath,
            cwd,
            startupTimeoutMs: 1000,
          })
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

test("reports child crashes with server diagnostics", async () => {
  await expect(
    connectLocalMigrateServer({
      cwd: process.cwd(),
      serverEntry: new URL("./fixtures/crashing-server.ts", import.meta.url),
      startupTimeoutMs: 2000,
    })
  ).rejects.toThrow("Migrate Server fixture crashed during startup");
});

test.each([
  [undefined, incompatibleProtocolMessage],
  ["sdk", "Migrate SDK version 999.0.0 is not supported"],
  ["capabilities", "missing required capabilities"],
  ["malformed", "Unable to connect to the local Migrate Server"],
] as const)("rejects incompatible server info (%s)", async (configPath, message) => {
  await expect(
    connectLocalMigrateServer({
      ...(configPath === undefined ? {} : { configPath }),
      cwd: process.cwd(),
      serverEntry: new URL("./fixtures/server-info.ts", import.meta.url),
      startupTimeoutMs: 2000,
    })
  ).rejects.toThrow(message);
});
