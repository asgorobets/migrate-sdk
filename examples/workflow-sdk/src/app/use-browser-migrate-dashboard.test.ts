import { Effect, Schema, Stream } from "effect";
import {
  MigrateDashboard,
  MigrateDashboardSnapshot,
} from "migrate-sdk/protocol";
import { describe, expect, it } from "vitest";
import {
  type BrowserMigrateDashboardObservationState,
  migrationMessageStateChanged,
  observeBrowserMigrateDashboard,
} from "./browser-migrate-dashboard-observation";
import {
  startVisibilityControlledObservation,
  type VisibilitySource,
} from "./visibility-controlled-observation";

const dashboardAfterRun = (runId: string) =>
  Schema.decodeUnknownSync(MigrateDashboard)({
    activeRuns: [],
    groups: [{ definitionIds: ["books"], id: "catalog" }],
    rows: [
      {
        entry: {
          dependencies: { optional: [], required: [] },
          group: "catalog",
          hasRollback: true,
          id: "books",
        },
        status: {
          definitionId: "books",
          discovery: "full",
          durable: {
            failed: 1,
            migrated: 8,
            needsUpdate: 0,
            skipped: 1,
          },
          lastRun: {
            definitionId: "books",
            definitionIds: ["books"],
            finishedAt: new Date("2026-08-31T20:00:01.000Z"),
            runId,
            runStatus: "failed",
            startedAt: new Date("2026-08-31T20:00:00.000Z"),
            status: "failed",
          },
          lock: null,
          warnings: [],
        },
      },
    ],
    scannedSource: false,
  });

describe("migrationMessageStateChanged", () => {
  it("refreshes messages when a later run produces the same item totals", () => {
    const previous = dashboardAfterRun("run-1");
    const next = dashboardAfterRun("run-2");

    expect(migrationMessageStateChanged(previous, next)).toBe(true);
    expect(migrationMessageStateChanged(next, next)).toBe(false);
  });
});

describe("browser dashboard observation", () => {
  it("publishes dashboard state before ancillary reads and retries failed reads", async () => {
    const dashboard = dashboardAfterRun("run-1");
    const definitionId = dashboard.rows[0]?.entry.id;
    if (definitionId === undefined) {
      throw new Error("Expected the dashboard fixture to contain a migration");
    }

    const snapshots = ["resume-1", "resume-2"].map((resumeToken) =>
      Schema.decodeUnknownSync(MigrateDashboardSnapshot)({
        dashboard,
        resumeToken,
      })
    );
    const state: BrowserMigrateDashboardObservationState = {
      initialized: false,
      messagesDashboard: undefined,
      sourceTotalsLoaded: false,
    };
    const dashboards: boolean[] = [];
    const messages: number[] = [];
    const totals: number[] = [];
    let messageAttempts = 0;
    let totalAttempts = 0;

    await Effect.runPromise(
      observeBrowserMigrateDashboard({
        retryAncillary: (effect) => effect,
        sink: {
          onDashboard: (_next, announceChanges) => {
            dashboards.push(announceChanges);
          },
          onMessages: (nextMessages) => {
            messages.push(nextMessages.length);
          },
          onSourceTotals: (nextTotals) => {
            const total = nextTotals.get(definitionId);
            totals.push(total?.kind === "known" ? total.count : -1);
          },
        },
        source: {
          getMessages: () =>
            Effect.suspend(() => {
              messageAttempts += 1;
              expect(dashboards).not.toHaveLength(0);
              return messageAttempts === 1
                ? Effect.fail(new Error("messages unavailable"))
                : Effect.succeed([]);
            }),
          getSourceItemTotals: () =>
            Effect.suspend(() => {
              totalAttempts += 1;
              expect(dashboards).not.toHaveLength(0);
              return totalAttempts === 1
                ? Effect.fail(new Error("totals unavailable"))
                : Effect.succeed([
                    {
                      definitionId,
                      total: { count: 10, kind: "known" as const },
                    },
                  ]);
            }),
          snapshots: Stream.fromIterable(snapshots),
        },
        state,
      })
    );

    expect(dashboards).toEqual([false, true]);
    expect(messageAttempts).toBe(2);
    expect(totalAttempts).toBe(2);
    expect(messages).toEqual([0]);
    expect(totals).toEqual([10]);
    expect(state.messagesDashboard).toStrictEqual(dashboard);
    expect(state.sourceTotalsLoaded).toBe(true);
  });
});

describe("visibility-controlled observation", () => {
  it("aborts hidden observations without letting stale completion clear a replacement", async () => {
    let hidden = false;
    const listeners = new Set<() => void>();
    const visibility: VisibilitySource = {
      isHidden: () => hidden,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const setHidden = (next: boolean): void => {
      hidden = next;
      for (const listener of listeners) {
        listener();
      }
    };
    const observations: Array<{
      readonly resolve: () => void;
      readonly signal: AbortSignal;
    }> = [];
    const controller = startVisibilityControlledObservation({
      onFailure: (cause) => {
        throw cause;
      },
      run: (signal) =>
        new Promise<void>((resolve) => {
          observations.push({ resolve, signal });
        }),
      visibility,
    });

    expect(observations).toHaveLength(1);
    setHidden(true);
    expect(observations[0]?.signal.aborted).toBe(true);

    setHidden(false);
    expect(observations).toHaveLength(2);
    observations[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    setHidden(false);
    expect(observations).toHaveLength(2);

    controller.dispose();
    expect(observations[1]?.signal.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    setHidden(false);
    expect(observations).toHaveLength(2);
  });
});
