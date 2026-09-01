import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { toMigrationDefinitionId } from "migrate-sdk";
import { connectLocalMigrateServerForTesting } from "migrate-sdk/client/node/testing";
import { makeMigrationTuiRuntimeWithLocalConnection } from "../../src/server/tui-runtime.ts";

const LOCK_ERROR_PATTERN = /lock/i;

const run = async (): Promise<void> => {
  const serverIdentity = `concurrent-local-connectors-${randomUUID()}`;
  const input = {
    configPath: resolve("test/fixtures/concurrent-runs.config.ts"),
    cwd: process.cwd(),
  };
  const connect = (connectionInput: typeof input) =>
    connectLocalMigrateServerForTesting(connectionInput, { serverIdentity });
  const [firstResult, secondResult] = await Promise.allSettled([
    makeMigrationTuiRuntimeWithLocalConnection(input, connect),
    makeMigrationTuiRuntimeWithLocalConnection(input, connect),
  ]);

  if (firstResult.status === "rejected" || secondResult.status === "rejected") {
    if (firstResult.status === "fulfilled") {
      await firstResult.value.dispose?.();
    }
    if (secondResult.status === "fulfilled") {
      await secondResult.value.dispose?.();
    }
    throw firstResult.status === "rejected"
      ? firstResult.reason
      : secondResult.reason;
  }

  const firstRuntime = firstResult.value;
  const secondRuntime = secondResult.value;

  try {
    const target = {
      definitionIds: [toMigrationDefinitionId("locked")],
      kind: "definitions" as const,
    };
    const firstRun = await firstRuntime.start(
      await firstRuntime.prepare(target, "run")
    );
    const overlappingOperation = await secondRuntime.prepare(target, "run");

    await assert.rejects(
      secondRuntime.start(overlappingOperation),
      LOCK_ERROR_PATTERN
    );
    await firstRuntime.stopRun(firstRun.runId);
    const outcome = await firstRuntime.observeRun(firstRun.runId);

    assert.equal(outcome.outcome, "cancelled");
    assert.equal(outcome.runId, firstRun.runId);
  } finally {
    await firstRuntime.dispose?.();
    await secondRuntime.dispose?.();
  }
};

const keepAlive = setInterval(() => undefined, 1000);

try {
  await run();
} catch (cause) {
  console.error(cause);
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
