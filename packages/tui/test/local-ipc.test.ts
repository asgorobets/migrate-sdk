import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toMigrationDefinitionId } from "migrate-sdk";
import { makeMigrationTuiRuntime } from "../src/index.ts";
import { connectLocalMigrateServer } from "../src/server/local-client.ts";

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
    const result = await runtime.execute(operation);

    expect(result.message).toContain("succeeded");
    expect((await runtime.refresh()).rows[0]?.status?.durable.migrated).toBe(1);
  } finally {
    await runtime.dispose?.();
  }
}, 20_000);

test("live observation does not block dashboard reads or explicit cancellation", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: resolve("examples/cancellation.config.ts"),
    cwd: process.cwd(),
  });
  const running = Promise.withResolvers<void>();
  const unsubscribe = runtime.subscribeExecution((state) => {
    if (state?.kind === "running") {
      running.resolve();
    }
  });

  try {
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("cancellable"),
        kind: "migration",
      },
      "run"
    );
    const execution = runtime.execute(operation);
    await within(running.promise, 2000);

    await expect(within(runtime.refresh(), 1000)).resolves.toBeDefined();
    await expect(runtime.cancelActiveExecution()).resolves.toMatchObject({
      kind: "requested",
    });
    await expect(execution).resolves.toMatchObject({
      message: expect.stringContaining("cancelled"),
    });
  } finally {
    unsubscribe();
    await runtime.dispose?.();
  }
}, 20_000);

test("reattaches to a detached run through the public run id", async () => {
  const runtime = await makeMigrationTuiRuntime({
    configPath: resolve("examples/detached-live-progress.config.ts"),
    cwd: process.cwd(),
  });
  const firstObserving = Promise.withResolvers<void>();
  const secondObserving = Promise.withResolvers<void>();
  let observationCount = 0;
  const unsubscribe = runtime.subscribeExecution((state) => {
    if (state?.kind === "observing") {
      observationCount += 1;
      if (observationCount === 1) {
        firstObserving.resolve();
      } else if (observationCount === 2) {
        secondObserving.resolve();
      }
    }
  });

  try {
    const operation = await runtime.prepare(
      {
        definitionId: toMigrationDefinitionId("live-progress"),
        kind: "migration",
      },
      "run"
    );
    const firstObservation = runtime.execute(operation);
    await within(firstObserving.promise, 2000);
    await expect(runtime.cancelActiveExecution()).resolves.toMatchObject({
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
    await within(secondObserving.promise, 2000);
    await expect(runtime.cancelActiveExecution()).resolves.toMatchObject({
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
    unsubscribe();
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
    const observing = Promise.withResolvers<void>();
    const unsubscribe = firstRuntime.subscribeExecution((state) => {
      if (state?.kind === "observing") {
        observing.resolve();
      }
    });
    const operation = await firstRuntime.prepare(
      {
        definitionId: toMigrationDefinitionId("persistent-reconnect"),
        kind: "migration",
      },
      "run"
    );
    const firstObservation = firstRuntime.execute(operation);
    await within(observing.promise, 3000);
    await expect(firstRuntime.cancelActiveExecution()).resolves.toMatchObject({
      kind: "detached",
    });
    const detached = await firstObservation;
    unsubscribe();
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
  [undefined, "Migrate Protocol version 3 is not supported"],
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
