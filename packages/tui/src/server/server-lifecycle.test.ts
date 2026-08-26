import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { waitForLocalMigrateServerIdle } from "./server-lifecycle.ts";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 1000;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met within 1000ms");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("local Migrate Server lifetime", () => {
  it("expires when its first client never connects", async () => {
    await Effect.runPromise(
      waitForLocalMigrateServerIdle({
        clientIds: Effect.succeed(new Set<number>()),
        hasActiveExecutions: () => false,
        initialConnectionTimeoutMs: 5,
        listActiveRuns: Effect.die("active-run discovery is not needed"),
        pollIntervalMs: 1,
      })
    );
  });

  it("keeps owned executions alive without durable discovery", async () => {
    const clients = new Set([1]);
    let clientReads = 0;
    let ownsExecution = true;
    let discoveryCalls = 0;
    const lifetime = Effect.runPromise(
      waitForLocalMigrateServerIdle({
        clientIds: Effect.sync(() => {
          clientReads += 1;
          return clients;
        }),
        hasActiveExecutions: () => ownsExecution,
        initialConnectionTimeoutMs: 50,
        listActiveRuns: Effect.sync(() => {
          discoveryCalls += 1;
          return [];
        }),
        pollIntervalMs: 1,
      })
    );

    await waitFor(() => clientReads > 0);
    clients.clear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(discoveryCalls).toBe(0);

    ownsExecution = false;
    await lifetime;
    expect(discoveryCalls).toBe(1);
  });

  it("retries active-run discovery after a transient failure", async () => {
    const clients = new Set([1]);
    let allowSuccess = false;
    let clientReads = 0;
    let discoveryCalls = 0;
    let settled = false;
    const lifetime = Effect.runPromise(
      waitForLocalMigrateServerIdle({
        clientIds: Effect.sync(() => {
          clientReads += 1;
          return clients;
        }),
        hasActiveExecutions: () => false,
        initialConnectionTimeoutMs: 50,
        listActiveRuns: Effect.suspend(() => {
          discoveryCalls += 1;
          return allowSuccess
            ? Effect.succeed([])
            : Effect.die("store unavailable");
        }),
        pollIntervalMs: 1,
      })
    ).finally(() => {
      settled = true;
    });

    await waitFor(() => clientReads > 0);
    clients.clear();
    await waitFor(() => discoveryCalls > 0);
    expect(settled).toBe(false);

    allowSuccess = true;
    await lifetime;
    expect(discoveryCalls).toBeGreaterThan(1);
  });
});
