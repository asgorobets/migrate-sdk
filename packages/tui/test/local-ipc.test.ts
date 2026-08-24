import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { toMigrationDefinitionId } from "migrate-sdk";
import { connectLocalMigrateServer } from "../src/server/local-client.ts";
import { makeLocalMigrationTuiRuntime } from "../src/server/tui-runtime.ts";

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

test("Bun operates a Node-only migration through local Effect RPC", async () => {
  const runtime = await makeLocalMigrationTuiRuntime({
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
  const runtime = await makeLocalMigrationTuiRuntime({
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
  [undefined, "Migrate Protocol version 2 is not supported"],
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
