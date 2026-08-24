import { describe, expect, it } from "vitest";
import { makeMigrationTuiExecutionProgressScheduler } from "./execution-progress.ts";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

const wait = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

describe("Migration TUI execution progress scheduler", () => {
  it("coalesces checkpoint bursts into targeted status reads", async () => {
    const reads: string[][] = [];
    const firstRead = Promise.withResolvers<void>();
    const scheduler = makeMigrationTuiExecutionProgressScheduler({
      definitionIds: ["authors", "articles"],
      fallbackIntervalMs: 60_000,
      onError: (cause) => {
        throw cause;
      },
      onProgress: () => undefined,
      read: async (definitionIds) => {
        reads.push([...definitionIds]);
        if (reads.length === 1) {
          await firstRead.promise;
        }
        return definitionIds;
      },
    });

    scheduler.request(["authors"]);
    await waitFor(() => reads.length === 1);
    scheduler.request(["authors"]);
    scheduler.request(["articles"]);
    scheduler.request(["articles"]);
    firstRead.resolve();
    await waitFor(() => reads.length === 2);
    await scheduler.stop();

    expect(reads).toEqual([["authors"], ["authors", "articles"]]);
  });

  it("aborts an active read when observation stops", async () => {
    let aborted = false;
    const scheduler = makeMigrationTuiExecutionProgressScheduler({
      definitionIds: ["authors"],
      fallbackIntervalMs: 60_000,
      onError: (cause) => {
        throw cause;
      },
      onProgress: () => undefined,
      read: (_definitionIds, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve([]);
            },
            { once: true }
          );
        }),
    });

    scheduler.request(["authors"]);
    await scheduler.stop();

    expect(aborted).toBe(true);
  });

  it("waits for a slow fallback read to finish before scheduling another", async () => {
    const reads: string[][] = [];
    const firstRead = Promise.withResolvers<void>();
    const scheduler = makeMigrationTuiExecutionProgressScheduler({
      definitionIds: ["authors", "articles"],
      fallbackIntervalMs: 10,
      onError: (cause) => {
        throw cause;
      },
      onProgress: () => undefined,
      read: async (definitionIds) => {
        reads.push([...definitionIds]);
        if (reads.length === 1) {
          await firstRead.promise;
        }
        return definitionIds;
      },
    });

    scheduler.start();
    await waitFor(() => reads.length === 1);
    await wait(25);
    expect(reads).toHaveLength(1);

    firstRead.resolve();
    await wait(5);
    expect(reads).toHaveLength(1);
    await waitFor(() => reads.length === 2);
    await scheduler.stop();

    expect(reads).toEqual([
      ["authors", "articles"],
      ["authors", "articles"],
    ]);
  });
});
