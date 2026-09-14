import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";
import {
  type MigrationMessage,
  type MigrationRunId,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import {
  type MigrateActiveRun,
  MigrateDashboardResumeToken,
  type MigrateDefinitionSourceItemTotal,
  type MigrateRunStartResult,
  type MigrateSourceIdentityHistoryEntry,
  type MigrateStoreSchemaPlan,
} from "migrate-sdk/protocol";
import {
  loadLocalMigrateServerRuntime,
  type MigrateServerExecutionHandle,
  type MigrateServerExecutionResult,
} from "migrate-sdk/server";
import { act } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MigrationTuiApp as MigrationTuiAppView } from "./app.tsx";
import type { MigrationTuiExecutionResult } from "./execution.ts";
import { MigrationTuiRenderErrorBoundary } from "./render-session.tsx";
import type {
  MigrationTuiDashboardObservationOptions,
  MigrationTuiExecuteOptions,
  MigrationTuiRuntime,
  MigrationTuiSnapshot,
} from "./runtime.ts";
import { useMigrationMessages } from "./use-migration-messages.ts";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
const processConcurrencyValuePattern = /│ 3\s+│/;
const rollbackConcurrencyValuePattern = /│ 5\s+│/;
const sourceInventoryScanConcurrencyValuePattern = /│ 2\s+│/;
const liveProgressNotRunPattern = /live-progress\s+NOT RUN/;
const liveProgressPrerequisiteCompletePattern =
  /live-progress-prerequisite\s+COMPLETE/;
const rollbackAuthorsRowPattern = /1\. [○✓] authors/u;
const messageRunId = toMigrationRunId("run-messages");
const serverFixtureUrl = new URL(
  "../../migrate-sdk/test/fixtures/server/",
  import.meta.url
);
const serverFixturePath = (fileName: string): string =>
  fileURLToPath(new URL(fileName, serverFixtureUrl));

const toTuiExecutionResult = (
  result: MigrateServerExecutionResult
): MigrationTuiExecutionResult => {
  const { message, outcome, runId } = result;

  if (outcome === "failed") {
    throw new Error(message);
  }

  return { message, outcome, runId };
};

const MigrationTuiApp = ({
  runtime,
}: {
  readonly runtime: MigrationTuiRuntime;
}) => (
  <MigrationTuiAppView
    lifecycle={{
      executionSettled: () => false,
      isExitRequested: () => false,
      requestExit: runtime.detachForExit,
    }}
    runtime={runtime}
  />
);

const makeInProcessMigrationTuiRuntime = async (
  ...args: Parameters<typeof loadLocalMigrateServerRuntime>
): Promise<MigrationTuiRuntime> => {
  const server = await Effect.runPromise(
    Effect.scoped(loadLocalMigrateServerRuntime(...args))
  );
  let activeObservation:
    | { readonly controller: AbortController; readonly runId: MigrationRunId }
    | undefined;
  interface InProcessExecution {
    readonly execution: MigrateServerExecutionHandle;
    observer?: MigrationTuiExecuteOptions | undefined;
    readonly result: Promise<MigrationTuiExecutionResult>;
  }
  interface DashboardObserver {
    lastResumeToken?: MigrationTuiSnapshot["resumeToken"] | undefined;
    readonly onSnapshot: MigrationTuiDashboardObservationOptions["onSnapshot"];
    readonly runtime: MigrationTuiRuntime;
  }
  const executions = new Map<MigrationRunId, InProcessExecution>();
  const dashboardObservers = new Set<DashboardObserver>();
  const refreshSnapshot = async (): Promise<MigrationTuiSnapshot> => {
    const snapshot = await Effect.runPromise(server.refresh);

    return {
      ...snapshot,
      resumeToken: MigrateDashboardResumeToken.make(
        `test:${JSON.stringify(snapshot)}`
      ),
    };
  };
  const publishDashboard = async (): Promise<void> => {
    await Promise.all(
      [...dashboardObservers].map(async (observer) => {
        const snapshot = await observer.runtime.refresh();

        if (observer.lastResumeToken !== snapshot.resumeToken) {
          observer.lastResumeToken = snapshot.resumeToken;
          observer.onSnapshot(snapshot);
        }
      })
    );
  };
  const detachRunObservation = (runId?: MigrationRunId): boolean => {
    if (
      activeObservation === undefined ||
      (runId !== undefined && activeObservation.runId !== runId)
    ) {
      return false;
    }

    const observation = activeObservation;
    activeObservation = undefined;
    observation.controller.abort();
    return true;
  };

  return {
    ...server,
    storeSchema: null,
    getStoreSchema: () => Promise.resolve(null),
    upgradeStoreSchema: () => Promise.reject(new Error("No SQL store")),
    breakLock: async (lock) => {
      const result = await Effect.runPromise(server.breakLock(lock));
      await publishDashboard();
      return result;
    },
    environmentLabel: basename(server.configPath),
    detachForExit: () => {
      const runId = activeObservation?.runId;
      if (runId === undefined) {
        return Promise.resolve({ kind: "idle" as const });
      }
      detachRunObservation(runId);
      return Promise.resolve({
        kind: "detached" as const,
        message: `Run ${runId} will continue after Migrate closes…`,
      });
    },
    detachRunObservation,
    listActiveRuns: () => Effect.runPromise(server.listActiveRuns),
    listMessages: (target) => Effect.runPromise(server.listMessages(target)),
    listSourceIdentityHistory: (definitionId) =>
      Effect.runPromise(server.listSourceIdentityHistory(definitionId)),
    getSourceItemTotals: (definitionIds) =>
      Effect.runPromise(server.getSourceItemTotals(definitionIds)),
    normalizeSourceIdentity: (definitionId, sourceIdentity) =>
      Effect.runPromise(
        server.normalizeSourceIdentity(definitionId, sourceIdentity)
      ),
    async observeDashboard(
      this: MigrationTuiRuntime,
      { after, onSnapshot, signal }: MigrationTuiDashboardObservationOptions
    ) {
      const observer: DashboardObserver = {
        lastResumeToken: after,
        onSnapshot,
        runtime: this,
      };
      dashboardObservers.add(observer);

      try {
        const snapshot = await this.refresh();
        if (snapshot.resumeToken !== observer.lastResumeToken) {
          observer.lastResumeToken = snapshot.resumeToken;
          onSnapshot(snapshot);
        }
        await new Promise<void>((resolve) => {
          if (signal?.aborted === true) {
            resolve();
            return;
          }

          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        dashboardObservers.delete(observer);
      }
    },
    observeRun: async (runId, options) => {
      detachRunObservation();
      const controller = new AbortController();
      activeObservation = { controller, runId };

      try {
        const localExecution = executions.get(runId);

        if (localExecution !== undefined) {
          localExecution.observer = options;
          const detached = new Promise<MigrationTuiExecutionResult>(
            (resolveDetached) => {
              controller.signal.addEventListener(
                "abort",
                () =>
                  resolveDetached({
                    message: `Run ${runId} continues in the background`,
                    outcome: "detached",
                    runId,
                  }),
                { once: true }
              );
            }
          );

          return await Promise.race([localExecution.result, detached]);
        }

        return await Effect.runPromise(server.observeRun(runId, options), {
          signal: controller.signal,
        }).then(toTuiExecutionResult);
      } catch (cause) {
        if (controller.signal.aborted) {
          return {
            message: `Run ${runId} continues in the background`,
            outcome: "detached" as const,
            runId,
          };
        }
        throw cause;
      } finally {
        const localExecution = executions.get(runId);
        if (localExecution !== undefined) {
          localExecution.observer = undefined;
        }
        if (activeObservation?.controller === controller) {
          activeObservation = undefined;
        }
      }
    },
    prepare: ((...input: Parameters<typeof server.prepare>) =>
      Effect.runPromise(server.prepare(...input)).then((operation) => ({
        ...operation,
        request: {
          selection: input[0],
          action: input[1],
          options: input[2] ?? {},
        },
      }))) as unknown as MigrationTuiRuntime["prepare"],
    refresh: refreshSnapshot,
    scanSource: (target, options) =>
      Effect.runPromise(server.scanSource(target, options)),
    start: async (operation) => {
      const started = Promise.withResolvers<MigrateRunStartResult>();
      let record: InProcessExecution | undefined;
      const execution = await Effect.runPromise(
        server.startExecution(
          operation as unknown as Parameters<typeof server.startExecution>[0],
          {
            onDashboardInvalidation: () => {
              publishDashboard().catch(() => undefined);
            },
            onObservationWarning: (message) =>
              record?.observer?.onObservationWarning?.(message),
            onProgress: (progress) => {
              record?.observer?.onProgress?.(progress);
              publishDashboard().catch(() => undefined);
            },
            onProgressError: (cause) =>
              record?.observer?.onProgressError?.(cause),
            onStateChange: (state) => {
              record?.observer?.onStateChange?.(state);
              publishDashboard().catch(() => undefined);
              if (state.kind === "running") {
                if (record !== undefined) {
                  executions.set(state.runId, record);
                }
                started.resolve({
                  runId: state.runId,
                  status: "started",
                });
              }
            },
          }
        )
      );
      const completion = Promise.withResolvers<MigrationTuiExecutionResult>();
      record = { execution, result: completion.promise };
      Effect.runPromise(execution.result)
        .then(toTuiExecutionResult)
        .then(completion.resolve, completion.reject);
      completion.promise
        .catch(() => undefined)
        .finally(() => {
          for (const [runId, candidate] of executions) {
            if (candidate === record) {
              executions.delete(runId);
            }
          }
          publishDashboard().catch(() => undefined);
        });

      return started.promise;
    },
    stopRun: async (runId) => {
      const record = executions.get(runId);
      if (record === undefined) {
        return {
          kind: "not-running" as const,
          message: `Run ${runId} is not running`,
          runId,
        };
      }

      const result = await Effect.runPromise(record.execution.stop);
      switch (result.kind) {
        case "requested":
          return { ...result, runId };
        case "provider-owned":
          return {
            kind: "unsupported" as const,
            message: result.message,
            runId,
          };
        case "idle":
          return {
            kind: "not-running" as const,
            message: `Run ${runId} is not running`,
            runId,
          };
        default: {
          const unhandled: never = result;
          return unhandled;
        }
      }
    },
  };
};

const schemaUpgradePlan: MigrateStoreSchemaPlan = {
  applied: [
    { id: 1, name: "initial_schema" },
    { id: 2, name: "definition_run_status" },
  ],
  currentVersion: 2,
  database: "sqlite",
  issues: [],
  pending: [
    {
      id: 3,
      name: "operation_history_and_completion",
      description:
        "Record operation history and migration completion separately",
    },
  ],
  planId: "v2-to-v3",
  status: "upgrade-required",
  tablePrefix: "migrate_sdk",
  targetVersion: 3,
  warnings: [],
};

const settle = async (
  renderOnce: () => Promise<void>,
  predicate: () => boolean,
  attempts = 300
): Promise<boolean> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await act(async () => {
      await renderOnce();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    });

    if (predicate()) {
      return true;
    }
  }

  return false;
};

beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

describe("MigrationTuiApp", () => {
  const itWithOpenTui = process.versions.bun === undefined ? it.skip : it;

  itWithOpenTui(
    "shows the schema popup before observing and upgrades only after confirmation",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const upgrade = Promise.withResolvers<MigrateStoreSchemaPlan>();
      const upgradeStoreSchema = vi.fn(() => upgrade.promise);
      const observeDashboard = vi.fn(base.observeDashboard.bind(base));
      const refresh = vi.fn(base.refresh);
      const runtime = {
        ...base,
        storeSchema: schemaUpgradePlan,
        upgradeStoreSchema,
        observeDashboard,
        refresh,
      };
      const setup = await createTestRenderer({ height: 24, width: 80 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Upgrade store")
          )
        ).toBe(true);
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Store schema upgrade required");
        expect(frame).toContain("Schema v2 → v3");
        expect(frame).toContain("Record operation history");
        expect(observeDashboard).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("ESCAPE"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Review schema")
          )
        ).toBe(true);
        expect(upgradeStoreSchema).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("r"));
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Upgrade store")
        );
        act(() => {
          setup.mockInput.pressKey("u");
          setup.mockInput.pressKey("u");
        });
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Upgrading")
        );
        expect(upgradeStoreSchema).toHaveBeenCalledOnce();
        expect(upgradeStoreSchema).toHaveBeenCalledWith(
          schemaUpgradePlan.planId
        );
        expect(observeDashboard).not.toHaveBeenCalled();
        await act(async () =>
          upgrade.resolve({
            ...schemaUpgradePlan,
            currentVersion: 3,
            status: "current",
            pending: [],
          })
        );
        expect(
          await settle(
            setup.renderOnce,
            () => observeDashboard.mock.calls.length === 1
          )
        ).toBe(true);
        expect(refresh).toHaveBeenCalledOnce();
        expect(setup.captureCharFrame()).not.toContain("Upgrade store");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps upgrade failures reviewable and uses the refreshed plan on retry",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const updated = { ...schemaUpgradePlan, planId: "changed-plan" };
      const upgradeStoreSchema = vi.fn(() =>
        Promise.reject(new Error("The store schema plan changed."))
      );
      const getStoreSchema = vi.fn(() => Promise.resolve(updated));
      const observeDashboard = vi.fn(base.observeDashboard.bind(base));
      const runtime = {
        ...base,
        storeSchema: schemaUpgradePlan,
        upgradeStoreSchema,
        getStoreSchema,
        observeDashboard,
      };
      const setup = await createTestRenderer({ height: 20, width: 60 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Upgrade store")
        );
        act(() => setup.mockInput.pressKey("u"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("The store schema plan changed.")
          )
        ).toBe(true);
        expect(getStoreSchema).toHaveBeenCalledOnce();
        expect(observeDashboard).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("u"));
        await settle(
          setup.renderOnce,
          () => upgradeStoreSchema.mock.calls.length === 2
        );
        expect(upgradeStoreSchema).toHaveBeenLastCalledWith("changed-plan");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "shows incompatible schema issues without offering an automatic upgrade",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const upgradeStoreSchema = vi.fn(base.upgradeStoreSchema);
      const runtime = {
        ...base,
        storeSchema: {
          ...schemaUpgradePlan,
          status: "future" as const,
          currentVersion: 9,
          pending: [],
          issues: ["Installed schema is newer than this SDK."],
        },
        upgradeStoreSchema,
      };
      const setup = await createTestRenderer({ height: 20, width: 60 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Check again")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("Installed schema is newer");
        expect(setup.captureCharFrame()).not.toContain("Upgrade store");
        act(() => setup.mockInput.pressKey("u"));
        expect(upgradeStoreSchema).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "reports an unexpected React failure to the lifecycle supervisor",
    async () => {
      const setup = await createTestRenderer({ height: 12, width: 80 });
      const root = createRoot(setup.renderer);
      const renderError = Promise.withResolvers<unknown>();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const CrashingView = () => {
        throw new Error("unexpected render failure");
      };

      act(() =>
        root.render(
          <MigrationTuiRenderErrorBoundary onError={renderError.resolve}>
            <CrashingView />
          </MigrationTuiRenderErrorBoundary>
        )
      );

      try {
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain(
          "The UI renderer failed. Recovering…"
        );
        await expect(renderError.promise).resolves.toMatchObject({
          message: "unexpected render failure",
        });
      } finally {
        consoleError.mockRestore();
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "refreshes durable state after mounting the recovery snapshot",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const refresh = vi.fn(runtime.refresh);
      const recoveredRuntime: MigrationTuiRuntime = { ...runtime, refresh };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() =>
        root.render(
          <MigrationTuiAppView
            initialRows={runtime.rows}
            lifecycle={{
              executionSettled: () => false,
              isExitRequested: () => false,
              requestExit: runtime.detachForExit,
            }}
            recoveryNotice="UI recovered from a renderer error; migration state was reloaded."
            runtime={recoveredRuntime}
          />
        )
      );

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes(
                "UI recovered from a renderer error; migration state was reloaded."
              )
          )
        ).toBe(true);
        expect(refresh).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "applies a manual durable refresh before restarting dashboard observation",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const durable = await baseRuntime.refresh();
      const rowWithStatus = durable.rows.find(
        (row) => row.status !== undefined
      );
      if (rowWithStatus?.status === undefined) {
        throw new Error("Expected a dashboard row with durable status");
      }
      const withMigratedCount = (migrated: number): MigrationTuiSnapshot => ({
        ...durable,
        resumeToken: MigrateDashboardResumeToken.make(
          `test:migrated:${migrated}`
        ),
        rows: durable.rows.map((row) =>
          row.entry.id === rowWithStatus.entry.id && row.status !== undefined
            ? {
                ...row,
                status: {
                  ...row.status,
                  durable: { ...row.status.durable, migrated },
                },
              }
            : row
        ),
      });
      const stale = withMigratedCount(1);
      const fresh = withMigratedCount(37);
      const observeDashboard = vi.fn<MigrationTuiRuntime["observeDashboard"]>(
        async ({ after, onSnapshot, signal }) => {
          if (after === undefined) {
            onSnapshot(stale);
          }

          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              resolve();
              return;
            }

            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      );
      const refresh = vi.fn(() => Promise.resolve(fresh));
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        observeDashboard,
        refresh,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("1 migrated")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("r", { shift: true }));

        expect(
          await settle(
            setup.renderOnce,
            () =>
              setup.captureCharFrame().includes("37 migrated") &&
              observeDashboard.mock.calls.length === 2
          )
        ).toBe(true);
        expect(refresh).toHaveBeenCalledOnce();
        expect(observeDashboard.mock.calls[1]?.[0].after).toBe(
          fresh.resumeToken
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "accumulates navigable session activity and opens JSONL export",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("l"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Session activity") &&
              frame.includes("3 RETAINED") &&
              (frame.match(/Status reloaded/g)?.length ?? 0) >= 2 &&
              frame.includes("Reloading status…")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("HOME"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Event 1")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("END"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Event 3")
          )
        ).toBe(true);

        act(() => setup.resize(72, 24));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Session activity") &&
              frame.includes("e export JSONL") &&
              frame.includes("Event 3")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("e"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Export session activity") &&
              frame.includes("JSONL") &&
              frame.includes("Existing files are not replaced")
            );
          })
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "records lifecycle changes for runs started outside this TUI",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const durable = await baseRuntime.refresh();
      const definitionId = toMigrationDefinitionId("authors");
      const runId = toMigrationRunId("run-external-authors");
      const activeRun = {
        definitionIds: [definitionId],
        observationDefinitionId: definitionId,
        runId,
        startedAt: new Date("2026-08-29T12:00:00.000Z"),
        status: "running",
        stopSupported: true,
      } satisfies MigrateActiveRun;
      let publishSnapshot:
        | MigrationTuiDashboardObservationOptions["onSnapshot"]
        | undefined;
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        observeDashboard: async ({ onSnapshot, signal }) => {
          publishSnapshot = onSnapshot;
          onSnapshot({
            ...durable,
            resumeToken: MigrateDashboardResumeToken.make(
              "session-activity:initial"
            ),
          });

          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              resolve();
              return;
            }
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() =>
          publishSnapshot?.({
            ...durable,
            activeRuns: [activeRun],
            resumeToken: MigrateDashboardResumeToken.make(
              "session-activity:running"
            ),
          })
        );
        act(() => setup.mockInput.pressKey("l"));
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes(`Run ${runId} running · ${definitionId}`)
          )
        ).toBe(true);

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("↵ Close") &&
              frame.includes(`Run ${runId} running · ${definitionId}`)
            );
          })
        ).toBe(true);

        act(() =>
          publishSnapshot?.({
            ...durable,
            activeRuns: [],
            resumeToken: MigrateDashboardResumeToken.make(
              "session-activity:complete"
            ),
          })
        );
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("↵ Close") &&
              frame.includes(`Run ${runId} running · ${definitionId}`) &&
              !frame.includes(
                `Run ${runId} is no longer active · ${definitionId}`
              )
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressEscape());
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes(`Run ${runId} is no longer active · ${definitionId}`)
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "expands and scrolls complete session activity messages",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const durable = await baseRuntime.refresh();
      const diagnostic = [
        "ACTIVITY-START",
        ...Array.from({ length: 30 }, (_, index) => `Diagnostic line ${index}`),
        "ACTIVITY-END",
      ].join("\n");
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        observeDashboard: ({ onSnapshot }) => {
          onSnapshot({
            ...durable,
            resumeToken: MigrateDashboardResumeToken.make(
              "session-activity:long-error"
            ),
          });
          return Promise.reject(new Error(diagnostic));
        },
      };
      const setup = await createTestRenderer({ height: 24, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("ACTIVITY-START")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("l"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("↵ expand")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Event 2") && frame.includes("ACTIVITY-START")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("END"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("ACTIVITY-END")
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "updates durable item counts while an inline run is still active",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("live-progress.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
        progressFallbackIntervalMs: 10,
        terminalPollIntervalMs: 10,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Status reloaded") && frame.includes("0 / 4 · 0%")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("r"));

        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            const hasIntermediateCount = [1, 2, 3].some((count) =>
              frame.includes(`${count} migrated`)
            );

            return hasIntermediateCount && frame.includes(" / 4 · ");
          })
        ).toBe(true);
        expect(
          await settle(
            setup.renderOnce,
            () => {
              const frame = setup.captureCharFrame();
              return (
                frame.includes("4 migrated") &&
                frame.includes("4 / 4 · 100%") &&
                frame.includes("succeeded")
              );
            },
            1500
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "debounces navigation and reuses source totals until an explicit reload",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const assetsId = toMigrationDefinitionId("assets");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const getSourceItemTotals = vi.fn(baseRuntime.getSourceItemTotals);
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () =>
              getSourceItemTotals.mock.calls.length === 1 &&
              setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("j"));
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey("j"));

        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 2
          )
        ).toBe(true);
        expect(
          getSourceItemTotals.mock.calls.map(([definitionIds]) => definitionIds)
        ).toEqual([[authorsId], [assetsId]]);

        act(() => setup.mockInput.pressKey("k"));
        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 3
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[2]?.[0]).toEqual([articlesId]);

        act(() => setup.mockInput.pressKey("k"));
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          await setup.renderOnce();
        });
        expect(getSourceItemTotals).toHaveBeenCalledTimes(3);

        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 4
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[3]?.[0]).toEqual([authorsId]);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "does not restart the source-total debounce for unchanged live snapshots",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const initialSnapshot = await baseRuntime.refresh();
      const getSourceItemTotals = vi.fn(baseRuntime.getSourceItemTotals);
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
        observeDashboard: ({ onSnapshot, signal }) =>
          new Promise<void>((resolve) => {
            let sequence = 0;
            const publish = () => {
              sequence += 1;
              onSnapshot({
                ...initialSnapshot,
                resumeToken: MigrateDashboardResumeToken.make(
                  `live-snapshot:${sequence}`
                ),
                rows: initialSnapshot.rows.map((row) => ({ ...row })),
              });
            };
            const interval = setInterval(publish, 20);
            const stop = () => {
              clearInterval(interval);
              resolve();
            };

            publish();
            if (signal?.aborted === true) {
              stop();
            } else {
              signal?.addEventListener("abort", stop, { once: true });
            }
          }),
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 1
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[0]?.[0]).toEqual([authorsId]);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          await setup.renderOnce();
        });
        expect(getSourceItemTotals).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "retires a source-total query error after a successful retry",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      let shouldFailAuthors = true;
      const getSourceItemTotals = vi.fn(
        (
          definitionIds: Parameters<
            MigrationTuiRuntime["getSourceItemTotals"]
          >[0]
        ) => {
          if (definitionIds[0] === authorsId && shouldFailAuthors) {
            shouldFailAuthors = false;
            return Promise.reject(new Error("temporary total failure"));
          }

          return baseRuntime.getSourceItemTotals(definitionIds);
        }
      );
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes("Unable to count source items: temporary total failure")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("j"));
        expect(
          await settle(
            setup.renderOnce,
            () =>
              getSourceItemTotals.mock.calls.length === 2 &&
              getSourceItemTotals.mock.calls[1]?.[0][0] === articlesId
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("k"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();

            return (
              getSourceItemTotals.mock.calls.length === 3 &&
              frame.includes("1 / 2 · 50%") &&
              !frame.includes("Unable to count source items")
            );
          })
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[2]?.[0]).toEqual([authorsId]);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "requests only uncached definitions when opening a group",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const assetsId = toMigrationDefinitionId("assets");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const getSourceItemTotals = vi.fn(baseRuntime.getSourceItemTotals);
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 1
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[0]?.[0]).toEqual([authorsId]);

        act(() => setup.mockInput.pressKey("g"));

        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 2
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[1]?.[0]).toEqual([
          articlesId,
          assetsId,
        ]);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "deduplicates in-flight totals across migration and group selections",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const assetsId = toMigrationDefinitionId("assets");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      let resolveAuthors:
        | ((totals: readonly MigrateDefinitionSourceItemTotal[]) => void)
        | undefined;
      const authorsRequest = new Promise<
        readonly MigrateDefinitionSourceItemTotal[]
      >((resolve) => {
        resolveAuthors = resolve;
      });
      let holdAuthorsRequest = true;
      const getSourceItemTotals = vi.fn(
        (
          definitionIds: Parameters<
            MigrationTuiRuntime["getSourceItemTotals"]
          >[0]
        ) => {
          if (
            holdAuthorsRequest &&
            definitionIds.length === 1 &&
            definitionIds[0] === authorsId
          ) {
            holdAuthorsRequest = false;
            return authorsRequest;
          }

          return baseRuntime.getSourceItemTotals(definitionIds);
        }
      );
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () =>
              getSourceItemTotals.mock.calls.length === 1 &&
              setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("g"));

        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 2
          )
        ).toBe(true);
        expect(
          getSourceItemTotals.mock.calls.map(([definitionIds]) => definitionIds)
        ).toEqual([[authorsId], [articlesId, assetsId]]);

        await act(async () => {
          resolveAuthors?.([
            {
              definitionId: authorsId,
              total: { count: 2, kind: "known" },
            },
          ]);
          await setup.renderOnce();
        });
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "combines an exact scan with cached counts for group progress",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const assetsId = toMigrationDefinitionId("assets");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const scanned = await baseRuntime.scanSource({
        definitionId: authorsId,
        kind: "migration",
      });
      const getSourceItemTotals = vi.fn(baseRuntime.getSourceItemTotals);
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
        observeDashboard: async ({ signal }) =>
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              resolve();
              return;
            }

            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() =>
        root.render(
          <MigrationTuiAppView
            initialRows={scanned.rows}
            lifecycle={{
              executionSettled: () => false,
              isExitRequested: () => false,
              requestExit: runtime.detachForExit,
            }}
            runtime={runtime}
          />
        )
      );

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("1 / 2 · 50%")
          )
        ).toBe(true);
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          await setup.renderOnce();
        });
        expect(getSourceItemTotals).not.toHaveBeenCalled();

        act(() => setup.mockInput.pressKey("j"));
        expect(
          await settle(
            setup.renderOnce,
            () => getSourceItemTotals.mock.calls.length === 1
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[0]?.[0]).toEqual([articlesId]);

        act(() => setup.mockInput.pressKey("g"));
        expect(
          await settle(
            setup.renderOnce,
            () =>
              getSourceItemTotals.mock.calls.length === 2 &&
              setup.captureCharFrame().includes("4 / 5 · 80%")
          )
        ).toBe(true);
        expect(getSourceItemTotals.mock.calls[1]?.[0]).toEqual([assetsId]);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps keyboard navigation available while a migration is running",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("dependent-live-progress.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
        progressFallbackIntervalMs: 10,
        terminalPollIntervalMs: 10,
      });
      const prerequisite = await runtime.prepare(
        {
          definitionIds: [
            toMigrationDefinitionId("live-progress-prerequisite"),
          ],
          kind: "definitions",
        },
        "run"
      );
      const prerequisiteRun = await runtime.start(prerequisite);
      await runtime.observeRun(prerequisiteRun.runId);
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("j"));
        expect(
          await settle(setup.renderOnce, () =>
            liveProgressNotRunPattern.test(setup.captureCharFrame())
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("r"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return [1, 2, 3].some((count) =>
              frame.includes(`${count} migrated`)
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("k"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              liveProgressPrerequisiteCompletePattern.test(frame) &&
              [1, 2, 3].some((count) => frame.includes(`${count} migrated`))
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("j"));
        expect(
          await settle(
            setup.renderOnce,
            () => {
              const frame = setup.captureCharFrame();
              return frame.includes("4 migrated");
            },
            1500
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "renders and follows a bounded message list while navigating many messages",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const messages: readonly MigrationMessage[] = Array.from(
        { length: 40 },
        (_, index) => {
          const message = {
            definitionId: toMigrationDefinitionId("authors"),
            message: `Message ${index + 1}`,
            runId: messageRunId,
            sourceIdentity: toEncodedSourceIdentity(
              `source-${String(index + 1).padStart(3, "0")}`
            ),
            updatedAt: new Date(
              `2026-08-23T09:${String(index).padStart(2, "0")}:00.000Z`
            ),
          };

          return index % 3 === 0
            ? ({
                ...message,
                kind: "update-reason",
                severity: "warning",
              } as const)
            : ({ ...message, kind: "skip-reason", severity: "info" } as const);
        }
      );
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        listMessages: async () => messages,
      };
      const setup = await createTestRenderer({
        height: 36,
        kittyKeyboard: true,
        width: 120,
      });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          setup.mockInput.pressKey("m");
          await setup.renderOnce();
        });
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Message 1 of 40") &&
              frame.includes("› 1/40") &&
              frame.includes("Source identity source-001 · item") &&
              frame.includes("Message 1") &&
              frame.includes("Source identity source-002 · item") &&
              frame.includes("Message 2")
            );
          })
        ).toBe(true);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          setup.mockInput.pressKey("END");
          await setup.renderOnce();
        });
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Message 40 of 40") &&
              frame.includes("› 40/40") &&
              frame.includes("Source identity source-040 · item") &&
              frame.includes("Message 40") &&
              frame.includes("Source identity source-039 · item") &&
              frame.includes("Message 39")
            );
          })
        ).toBe(true);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          setup.mockInput.pressKey("HOME");
          await setup.renderOnce();
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Message 1 of 40")
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "reuses loaded messages when returning to a migration",
    async () => {
      const authorsId = toMigrationDefinitionId("authors");
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const redundantRequest =
        Promise.withResolvers<readonly MigrationMessage[]>();
      const listMessages = vi.fn(
        (target: Parameters<MigrationTuiRuntime["listMessages"]>[0]) => {
          const requestsForTarget = listMessages.mock.calls.filter(
            ([candidate]) => {
              if (
                candidate.kind === "migration" &&
                target.kind === "migration"
              ) {
                return candidate.definitionId === target.definitionId;
              }
              if (candidate.kind === "group" && target.kind === "group") {
                return candidate.groupId === target.groupId;
              }

              return false;
            }
          );

          return requestsForTarget.length > 1
            ? redundantRequest.promise
            : Promise.resolve([]);
        }
      );
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        listMessages,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () =>
              listMessages.mock.calls.length === 1 &&
              setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("j"));
        expect(
          await settle(
            setup.renderOnce,
            () => listMessages.mock.calls.length === 2
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("k"));
        await act(async () => {
          await setup.renderOnce();
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          await setup.renderOnce();
        });

        expect(listMessages).toHaveBeenCalledTimes(3);

        act(() => setup.mockInput.pressKey("m"));
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("No messages.");
        expect(setup.captureCharFrame()).not.toContain("Loading messages…");

        redundantRequest.resolve([
          {
            definitionId: authorsId,
            kind: "skip-reason",
            message: "New source message",
            runId: messageRunId,
            severity: "info",
            sourceIdentity: toEncodedSourceIdentity("source-new"),
            updatedAt: new Date("2026-08-29T12:00:00.000Z"),
          },
        ]);
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("New source message")
          )
        ).toBe(true);
      } finally {
        redundantRequest.resolve([]);
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "never returns messages from the previous migration during navigation",
    async () => {
      const authorsTarget = {
        definitionId: toMigrationDefinitionId("authors"),
        kind: "migration",
      } as const;
      const articlesTarget = {
        definitionId: toMigrationDefinitionId("articles"),
        kind: "migration",
      } as const;
      const message = (
        target: typeof authorsTarget | typeof articlesTarget
      ): MigrationMessage => ({
        definitionId: target.definitionId,
        kind: "skip-reason",
        message: `${target.definitionId} message`,
        runId: messageRunId,
        severity: "info",
        sourceIdentity: toEncodedSourceIdentity(`${target.definitionId}-1`),
        updatedAt: new Date("2026-08-29T12:00:00.000Z"),
      });
      const listMessages: MigrationTuiRuntime["listMessages"] = vi.fn(
        (target) =>
          Promise.resolve(target.kind === "migration" ? [message(target)] : [])
      );
      const runtime = { listMessages };
      const setError = vi.fn();
      const snapshots: Array<{
        readonly loading: boolean;
        readonly messages: readonly MigrationMessage[];
        readonly target: string;
      }> = [];
      const MessageSnapshot = ({
        target,
      }: {
        readonly target: typeof authorsTarget | typeof articlesTarget;
      }) => {
        const snapshot = useMigrationMessages({ runtime, setError, target });
        snapshots.push({ ...snapshot, target: target.definitionId });
        return <box />;
      };
      const setup = await createTestRenderer({ height: 5, width: 40 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MessageSnapshot target={authorsTarget} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            snapshots.some(
              (snapshot) =>
                snapshot.target === authorsTarget.definitionId &&
                snapshot.messages[0]?.message === "authors message"
            )
          )
        ).toBe(true);

        snapshots.length = 0;
        act(() => root.render(<MessageSnapshot target={articlesTarget} />));

        expect(snapshots[0]).toMatchObject({
          loading: true,
          messages: [],
          target: articlesTarget.definitionId,
        });
        expect(
          snapshots[0]?.messages.some(
            (candidate) => candidate.definitionId === authorsTarget.definitionId
          )
        ).toBe(false);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "expands and scrolls long messages while keeping controls visible",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        listMessages: async () => [
          {
            definitionId: toMigrationDefinitionId("articles"),
            details: {
              context: `DETAILS-START ${"structured migration detail ".repeat(100)} DETAILS-END`,
            },
            kind: "process-diagnostic",
            message: `MESSAGE-START ${"long migration message ".repeat(100)} MESSAGE-END`,
            runId: messageRunId,
            sequence: 0,
            severity: "warning",
            sourceIdentity: toEncodedSourceIdentity("source-long-message"),
            updatedAt: new Date("2026-08-23T09:00:00.000Z"),
          },
        ],
      };
      const setup = await createTestRenderer({ height: 24, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          setup.mockInput.pressKey("m");
          await setup.renderOnce();
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("MESSAGE-START")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("↵ expand");

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Message 1 of 1") &&
              frame.includes(`Migration Run ${messageRunId}`) &&
              frame.includes("MESSAGE-START") &&
              frame.includes("↵ Close")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("END"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return frame.includes("DETAILS-END") && frame.includes("↵ Close");
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("ESCAPE"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("↵ expand")
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "identifies the owning migration in group messages",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("g"));
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey("m"));

        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("articles · Source identity article-") &&
              frame.includes("↵ expand")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes("articles · Source identity article-")
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "shows source inventory counts and bounded scan warnings",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("source-status.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      let scannedTarget:
        | Parameters<MigrationTuiRuntime["scanSource"]>[0]
        | null = null;
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        scanSource: async (target) => {
          scannedTarget = target;
          return await baseRuntime.scanSource(target);
        },
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Not scanned · press s to scan")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("s"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Source Inventory Scan complete") &&
              frame.includes(
                "3 total · 2 unprocessed · 0 invalid · 1 duplicate · 0 orphaned"
              ) &&
              frame.includes("Duplicate product-duplicate · 2 occurrences")
            );
          })
        ).toBe(true);
        expect(scannedTarget).toEqual({
          definitionId: toMigrationDefinitionId("products"),
          kind: "migration",
        });
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "does not count a selected source with an exact inventory scan",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("source-status.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const target = {
        definitionId: toMigrationDefinitionId("products"),
        kind: "migration" as const,
      };
      const scanned = await baseRuntime.scanSource(target);
      const getSourceItemTotals = vi.fn(baseRuntime.getSourceItemTotals);
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        getSourceItemTotals,
        observeDashboard: async ({ signal }) =>
          await new Promise<void>((resolve) => {
            if (signal?.aborted === true) {
              resolve();
              return;
            }

            signal?.addEventListener("abort", () => resolve(), { once: true });
          }),
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() =>
        root.render(
          <MigrationTuiAppView
            initialRows={scanned.rows}
            lifecycle={{
              executionSettled: () => false,
              isExitRequested: () => false,
              requestExit: runtime.detachForExit,
            }}
            runtime={runtime}
          />
        )
      );

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("3 total")
          )
        ).toBe(true);
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          await setup.renderOnce();
        });
        expect(getSourceItemTotals).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "reloads status after a source inventory scan without crashing the renderer",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("source-status.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Not scanned · press s to scan")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("s"));
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes(
                "3 total · 2 unprocessed · 0 invalid · 1 duplicate · 0 orphaned"
              )
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Not scanned · press s to scan") ||
              frame.includes("TypeError:")
            );
          })
        ).toBe(true);

        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("TypeError:");
        expect(frame).toContain("Not scanned · press s to scan");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "scrolls compact overview details without moving the migration selection",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("source-status.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 28, width: 72 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("products");

        act(() => setup.mockInput.pressKey("\u001B[6~"));
        act(() => setup.mockInput.pressKey("\u001B[6~"));

        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Capabilities")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("products");
        expect(setup.captureCharFrame()).toContain("PgUp/PgDn details");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "offers run focus and an explicit stop for a server-owned locked run",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("locked.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const runId = toMigrationRunId("run-stuck");
      const observeRun = vi.fn(() =>
        Promise.resolve({
          message: `Run ${runId} cancelled`,
          outcome: "cancelled" as const,
          runId,
        })
      );
      const stopRun = vi.fn(() =>
        Promise.resolve({
          kind: "unsupported" as const,
          message: `Run ${runId} cannot be stopped by this Migrate Server`,
          runId,
        })
      );
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        refresh: async () => ({
          ...(await baseRuntime.refresh()),
          activeRuns: [
            {
              definitionIds: [toMigrationDefinitionId("locked-migration")],
              execution: {
                adapter: "workflow-sdk",
                executionId: "workflow-stuck",
              },
              observationDefinitionId:
                toMigrationDefinitionId("locked-migration"),
              runId,
              startedAt: new Date("2026-08-25T12:00:00.000Z"),
              status: "running" as const,
              stopSupported: true,
            },
          ],
        }),
        observeRun,
        stopRun,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () =>
              setup.captureCharFrame().includes("v View run") &&
              setup.captureCharFrame().includes("x Stop run")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("l"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("WARNING") &&
              frame.includes(`Run ${runId} cancelled`)
            );
          })
        ).toBe(true);
        act(() => setup.mockInput.pressEscape());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("x Stop run")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("x"));
        expect(
          await settle(setup.renderOnce, () => stopRun.mock.calls.length > 0)
        ).toBe(true);
        expect(stopRun).toHaveBeenCalledWith(runId);

        act(() => setup.mockInput.pressKey("l"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("WARNING") &&
              frame.includes(
                `Run ${runId} cannot be stopped by this Migrate Server`
              )
            );
          })
        ).toBe(true);
        act(() => setup.mockInput.pressEscape());

        act(() => setup.mockInput.pressKey("v"));
        expect(
          await settle(setup.renderOnce, () => observeRun.mock.calls.length > 0)
        ).toBe(true);
        expect(observeRun).toHaveBeenCalledWith(runId, expect.any(Object));
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "moves run observation with migration selection without stopping the run",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const durable = await baseRuntime.refresh();
      const definitionId = toMigrationDefinitionId("authors");
      const runId = toMigrationRunId("run-authors-active");
      const rows = durable.rows.map((row) =>
        row.entry.id !== definitionId || row.status === undefined
          ? row
          : {
              ...row,
              status: {
                ...row.status,
                lock: {
                  createdAt: new Date("2026-08-25T12:00:00.000Z"),
                  definitionId,
                  ownerRunId: runId,
                  token: toMigrationDefinitionLockToken("lock-authors-active"),
                },
              },
            }
      );
      const observation = Promise.withResolvers<never>();
      const observeRun = vi.fn<MigrationTuiRuntime["observeRun"]>(
        () => observation.promise
      );
      const detachRunObservation = vi.fn((_runId?: typeof runId) => true);
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        detachRunObservation,
        observeRun,
        refresh: () =>
          Promise.resolve({
            ...durable,
            activeRuns: [
              {
                definitionIds: [definitionId],
                observationDefinitionId: definitionId,
                runId,
                startedAt: new Date("2026-08-25T12:00:00.000Z"),
                status: "running" as const,
                stopSupported: true,
              },
            ],
            rows,
          }),
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () => observeRun.mock.calls.length > 0)
        ).toBe(true);
        expect(observeRun).toHaveBeenCalledWith(runId, expect.any(Object));
        expect(observeRun.mock.calls[0]?.[1]?.onProgress).toBeUndefined();

        act(() => setup.mockInput.pressKey("j"));

        expect(
          await settle(setup.renderOnce, () =>
            detachRunObservation.mock.calls.some(
              ([detachedRunId]) => detachedRunId === runId
            )
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps durable active-run actions after a source scan",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("locked.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const definitionId = toMigrationDefinitionId("locked-migration");
      const runId = toMigrationRunId("run-stuck");
      const durable = await baseRuntime.refresh();
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        refresh: async () => ({
          ...durable,
          activeRuns: [
            {
              definitionIds: [definitionId],
              execution: {
                adapter: "workflow-sdk",
                executionId: "workflow-stuck",
              },
              observationDefinitionId: definitionId,
              runId,
              startedAt: new Date("2026-08-25T12:00:00.000Z"),
              status: "running" as const,
              stopSupported: true,
            },
          ],
        }),
        scanSource: async () => ({
          ...durable,
          activeRuns: [],
          scannedSource: true,
        }),
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("v View run")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("s"));

        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Source Inventory Scan complete")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("v View run");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "reloads durable status after a reconnectable run fails",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("locked.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const runId = toMigrationRunId("run-stuck");
      const activeRun = {
        definitionIds: [toMigrationDefinitionId("locked-migration")] as const,
        execution: {
          adapter: "workflow-sdk",
          executionId: "workflow-stuck",
        },
        observationDefinitionId: toMigrationDefinitionId("locked-migration"),
        runId,
        startedAt: new Date("2026-08-25T12:00:00.000Z"),
        status: "running" as const,
        stopSupported: true,
      };
      const durable = await baseRuntime.refresh();
      let onDashboardSnapshot:
        | MigrationTuiDashboardObservationOptions["onSnapshot"]
        | undefined;
      let dashboardObservationCalls = 0;
      let refreshCalls = 0;
      const refresh = vi.fn<MigrationTuiRuntime["refresh"]>(
        (): Promise<MigrationTuiSnapshot> => {
          refreshCalls += 1;
          const snapshot =
            refreshCalls === 1
              ? { ...durable, activeRuns: [activeRun] }
              : { ...durable, activeRuns: [] };

          if (refreshCalls > 1) {
            onDashboardSnapshot?.(snapshot);
          }

          return Promise.resolve(snapshot);
        }
      );
      const observeRun = vi.fn(() =>
        Promise.reject(new Error(`Run ${runId} failed`))
      );
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        refresh,
        observeDashboard: async ({ onSnapshot, signal }) => {
          dashboardObservationCalls += 1;
          onDashboardSnapshot = onSnapshot;
          onSnapshot(await refresh());

          await new Promise<void>((resolve) =>
            signal?.addEventListener("abort", () => resolve(), { once: true })
          );
        },
        observeRun,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(
            setup.renderOnce,
            () =>
              refresh.mock.calls.length >= 3 &&
              setup.captureCharFrame().includes(`Run ${runId} failed`)
          )
        ).toBe(true);
        expect(observeRun).toHaveBeenCalledWith(runId, expect.any(Object));
        expect(refresh).toHaveBeenCalledTimes(3);
        expect(dashboardObservationCalls).toBe(2);
        expect(setup.captureCharFrame()).not.toContain("v View run");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "shows lock ownership and requires confirmation before breaking a lock",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("locked.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Owner run  run-stuck") &&
              frame.includes("Token      lock-stuck") &&
              frame.includes("u Break lock")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("u"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Break migration lock") &&
              frame.includes("Only break this lock after confirming") &&
              frame.includes("y break lock · n/esc cancel")
            );
          })
        ).toBe(true);

        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Lock cleared for locked-migration") &&
              !frame.includes("u Break lock") &&
              !frame.includes("Break migration lock")
            );
          })
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "retries skipped items from the selected migration",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressArrow("down"));
        act(() => setup.mockInput.pressArrow("down"));
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("t Retry skipped");

        act(() => setup.mockInput.pressKey("t"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("1 migrated")
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps secondary retries in All actions without crowding the primary row",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        refresh: async () => {
          const snapshot = await baseRuntime.refresh();

          return {
            ...snapshot,
            rows: snapshot.rows.map((row) =>
              row.entry.id === "articles" && row.status !== undefined
                ? {
                    ...row,
                    status: {
                      ...row.status,
                      durable: { ...row.status.durable, skipped: 1 },
                    },
                  }
                : row
            ),
          };
        },
      };
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("g"));
        await act(async () => setup.renderOnce());
        const dashboard = setup.captureCharFrame();
        expect(dashboard).toContain("f Retry failed");
        expect(dashboard).not.toContain("t Retry skipped");
        expect(dashboard).toContain("↵ All actions");

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("All actions · content")
          )
        ).toBe(true);
        const allActions = setup.captureCharFrame();
        expect(allActions).toContain("Retry failed");
        expect(allActions).toContain("[f]");
        expect(allActions).toContain("Retry skipped");
        expect(allActions).toContain("[t]");
        expect(allActions).toContain("Concurrency settings");
        expect(allActions).toContain("[c]");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "edits concurrency with numeric fields and explicit unbounded choices",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("g"));
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("All actions · content")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("c"));

        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Concurrency settings")
          )
        ).toBe(true);
        const concurrencySettings = setup.captureCharFrame();
        expect(concurrencySettings).toContain("Process Pipeline concurrency");
        expect(concurrencySettings).toContain("Rollback Pipeline concurrency");
        expect(concurrencySettings).toContain(
          "Source Inventory Scan concurrency"
        );
        expect(concurrencySettings.match(/Unbounded/g)?.length ?? 0).toBe(2);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
        });
        await act(async () => setup.renderOnce());
        await act(async () => setup.mockInput.typeText("3"));
        expect(
          await settle(setup.renderOnce, () =>
            processConcurrencyValuePattern.test(setup.captureCharFrame())
          )
        ).toBe(true);
        act(() => setup.mockInput.pressTab());
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey(" "));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("✓ Unbounded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressTab());
        await act(async () => setup.renderOnce());
        await act(async () => setup.mockInput.typeText("4"));
        act(() => setup.mockInput.pressArrow("up"));
        expect(
          await settle(setup.renderOnce, () =>
            rollbackConcurrencyValuePattern.test(setup.captureCharFrame())
          )
        ).toBe(true);
        act(() => setup.mockInput.pressTab());
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey(" "));
        expect(
          await settle(
            setup.renderOnce,
            () =>
              (setup.captureCharFrame().match(/✓ Unbounded/g)?.length ?? 0) ===
              2
          )
        ).toBe(true);
        act(() => setup.mockInput.pressTab());
        await act(async () => setup.renderOnce());
        await act(async () => setup.mockInput.typeText("2"));

        expect(
          await settle(setup.renderOnce, () =>
            sourceInventoryScanConcurrencyValuePattern.test(
              setup.captureCharFrame()
            )
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("s", { ctrl: true }));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("All actions · content")
          )
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "offers include or force when rescan dependencies are unmet",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("dependency-preflight.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressArrow("down"));
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("All actions · articles")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressArrow("down"));
        act(() => setup.mockInput.pressArrow("down"));
        act(() => setup.mockInput.pressEnter());

        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Dependencies incomplete") &&
              frame.includes("Rescan migrations with dependencies") &&
              frame.includes(
                "Force skips dependencies; some items may fail."
              ) &&
              frame.includes("i Include dependencies") &&
              frame.includes("f Force rescan")
            );
          })
        ).toBe(true);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "executes an expanded dependency plan without crashing the renderer",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("dependency-preflight.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressArrow("down"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("articles  NOT RUN")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("r"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Dependencies incomplete")
          )
        ).toBe(true);

        expect(setup.captureCharFrame()).toContain(
          "Run migrations with dependencies"
        );
        expect(setup.captureCharFrame()).toContain("Run order");
        act(() => setup.resize(72, 24));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("i include · f force")
          )
        ).toBe(true);

        act(() => {
          setup.resize(120, 36);
          setup.mockInput.pressKey("i");
        });
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return frame.includes("✓ articles") || frame.includes("TypeError:");
          })
        ).toBe(true);

        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("TypeError:");
        expect(frame).toContain("✓ authors");
        expect(frame).toContain("✓ articles");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "preserves selected entries and reruns multiple identities from durable history",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressArrow("down"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("articles  COMPLETE")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("e"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Run selected entries") &&
              frame.includes("article-welcome") &&
              frame.includes("MIGRATED") &&
              frame.includes("article-effect") &&
              frame.includes("FAILED")
            );
          })
        ).toBe(true);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        });
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey(" "));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("1 selected")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressEscape());
        expect(
          await settle(
            setup.renderOnce,
            () => !setup.captureCharFrame().includes("Run selected entries")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("e"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Run selected entries") &&
              frame.includes("1 selected")
            );
          })
        ).toBe(true);

        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        });
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressArrow("down"));
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey(" "));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("2 selected")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return frame.includes("2 migrated") || frame.includes("TypeError:");
          })
        ).toBe(true);

        expect(setup.captureCharFrame()).not.toContain("TypeError:");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "ignores history that resolves after the operator opens another migration",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const authorsHistory =
        Promise.withResolvers<readonly MigrateSourceIdentityHistoryEntry[]>();
      const articlesHistory =
        Promise.withResolvers<readonly MigrateSourceIdentityHistoryEntry[]>();
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        listSourceIdentityHistory: (definitionId) => {
          if (definitionId === authorsId) {
            return authorsHistory.promise;
          }
          if (definitionId === articlesId) {
            return articlesHistory.promise;
          }
          return Promise.resolve([]);
        },
      };
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("e"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Run selected entries")
          )
        ).toBe(true);
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        });
        act(() => setup.mockInput.pressEscape());
        expect(
          await settle(
            setup.renderOnce,
            () => !setup.captureCharFrame().includes("Run selected entries")
          )
        ).toBe(true);
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        });

        act(() => setup.mockInput.pressKey("j"));
        await act(async () => setup.renderOnce());
        const selectedFrame = setup.captureCharFrame();
        expect(selectedFrame.includes("│ articles  COMPLETE")).toBe(true);
        act(() => setup.mockInput.pressKey("e"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Loading history…")
          )
        ).toBe(true);

        await act(async () => {
          authorsHistory.resolve([
            {
              sourceIdentity: "author-stale",
              status: "migrated",
              updatedAt: new Date("2026-08-23T09:00:00.000Z"),
            },
          ]);
          await Promise.resolve();
        });
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).not.toContain("author-stale");
        expect(setup.captureCharFrame()).toContain("Loading history…");

        await act(async () => {
          articlesHistory.resolve([
            {
              sourceIdentity: "article-current",
              status: "failed",
              updatedAt: new Date("2026-08-23T09:01:00.000Z"),
            },
          ]);
          await Promise.resolve();
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("article-current")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("author-stale");
        expect(setup.captureCharFrame()).toContain("1 item");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "prepares rollback orphans from All actions and requires confirmation",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const prepare = vi.spyOn(runtime, "prepare");
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("All actions · authors")
          )
        ).toBe(true);
        for (let index = 0; index < 6; index += 1) {
          act(() => setup.mockInput.pressArrow("down"));
        }
        act(() => setup.mockInput.pressEnter());

        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Confirm orphan rollback")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("y Rollback orphans");
        expect(prepare).toHaveBeenCalledWith(
          {
            definitionIds: [toMigrationDefinitionId("authors")],
            kind: "definitions",
          },
          "run",
          expect.objectContaining({ rollbackOrphans: true })
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  for (const scope of ["include", "force"] as const) {
    itWithOpenTui(
      `preserves orphan cleanup when choosing ${scope} and confirms the displayed plan`,
      async () => {
        const runtime = await makeInProcessMigrationTuiRuntime({
          configPath: serverFixturePath("dependency-preflight.config.ts"),
          cwd: new URL("..", import.meta.url).pathname,
        });
        const reset = await runtime.prepare(
          {
            definitionIds: [toMigrationDefinitionId("authors")],
            kind: "definitions",
          },
          "rollback",
          { withDependencies: true }
        );
        const resetRun = await runtime.start(reset);
        await runtime.observeRun(resetRun.runId);
        const prepare = vi.spyOn(runtime, "prepare");
        const start = vi.spyOn(runtime, "start");
        const setup = await createTestRenderer({ height: 36, width: 120 });
        const root = createRoot(setup.renderer);
        act(() => root.render(<MigrationTuiApp runtime={runtime} />));

        try {
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Status reloaded")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressArrow("down"));
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("All actions · articles")
            )
          ).toBe(true);
          for (let index = 0; index < 6; index += 1) {
            act(() => setup.mockInput.pressArrow("down"));
          }
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Dependencies incomplete")
            )
          ).toBe(true);
          expect(setup.captureCharFrame()).toContain(
            "Rollback orphaned items with dependencies"
          );
          expect(setup.captureCharFrame()).toContain(
            "f Force rollback orphans"
          );
          expect(setup.captureCharFrame()).not.toContain("y Rollback orphans");
          act(() => setup.mockInput.pressKey("y"));
          await act(async () => setup.renderOnce());
          expect(start).not.toHaveBeenCalled();

          act(() => setup.mockInput.pressKey(scope === "include" ? "i" : "f"));
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Confirm orphan rollback")
            )
          ).toBe(true);
          expect(start).not.toHaveBeenCalled();
          expect(prepare).toHaveBeenLastCalledWith(
            {
              definitionIds: [toMigrationDefinitionId("articles")],
              kind: "definitions",
            },
            "run",
            expect.objectContaining({
              rollbackOrphans: true,
              withDependencies: scope === "include",
              force: scope === "force",
            })
          );
          const prepared = await prepare.mock.results.at(-1)?.value;
          if (prepared === undefined) {
            throw new Error("Expected a prepared orphan cleanup");
          }
          const expectedIds =
            scope === "include" ? ["authors", "articles"] : ["articles"];
          expect(prepared.plan.executionDefinitionIds).toEqual(expectedIds);
          expect(setup.captureCharFrame()).toContain("Migration plan");
          expect(setup.captureCharFrame()).toContain(
            scope === "include" ? "2. ○ articles" : "1. ○ articles"
          );
          const preparationCount = prepare.mock.calls.length;
          act(() => setup.mockInput.pressKey("f"));
          await act(async () => setup.renderOnce());
          expect(prepare.mock.calls.length).toBe(preparationCount);
          act(() => setup.mockInput.pressKey("y"));
          expect(
            await settle(setup.renderOnce, () => start.mock.calls.length === 1)
          ).toBe(true);
          expect(start.mock.calls[0]?.[0]).toEqual(prepared);
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("succeeded")
            )
          ).toBe(true);
        } finally {
          act(() => root.unmount());
          setup.renderer.destroy();
        }
      }
    );
  }

  itWithOpenTui(
    "prepares selected source identities for rollback before confirmation",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const prepare = vi.spyOn(runtime, "prepare");
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("All actions · authors")
          )
        ).toBe(true);
        for (let index = 0; index < 5; index += 1) {
          act(() => setup.mockInput.pressArrow("down"));
        }
        act(() => setup.mockInput.pressEnter());

        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Rollback selected entries")
          )
        ).toBe(true);
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 120));
        });
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressKey(" "));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("1 selected")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressEnter());

        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Confirm rollback")
        );
        expect(setup.captureCharFrame()).toContain("Confirm rollback");
        expect(prepare).toHaveBeenCalledWith(
          {
            definitionIds: [toMigrationDefinitionId("authors")],
            kind: "definitions",
          },
          "rollback",
          expect.objectContaining({
            sourceIdentities: expect.arrayContaining([expect.any(String)]),
            withDependencies: false,
          })
        );
        expect(setup.captureCharFrame()).toContain("y Rollback selected");
        expect(setup.captureCharFrame()).toContain("Rollback 1 selected entry");
        const prepareCount = prepare.mock.calls.length;
        act(() => setup.mockInput.pressKey("i"));
        await act(async () => setup.renderOnce());
        expect(prepare).toHaveBeenCalledTimes(prepareCount);
        expect(setup.captureCharFrame()).toContain("● s Selected only");
        expect(setup.captureCharFrame()).not.toContain("Force rollback");
        expect(prepare).toHaveBeenLastCalledWith(
          expect.anything(),
          "rollback",
          expect.objectContaining({
            force: true,
            sourceIdentities: expect.arrayContaining([expect.any(String)]),
            withDependencies: false,
          })
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "blocks confirmation during rollback plan refresh and ignores a cancelled refresh",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/transitive-dependency.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const pending =
        Promise.withResolvers<
          Awaited<ReturnType<MigrationTuiRuntime["prepare"]>>
        >();
      const start = vi.fn(base.start);
      const prepare = vi.fn<MigrationTuiRuntime["prepare"]>(
        (selection, action, options) =>
          options?.withDependencies === false
            ? pending.promise
            : base.prepare(selection, action, options)
      );
      const runtime = { ...base, prepare, start };
      const setup = await createTestRenderer({ height: 30, width: 100 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Status reloaded")
        );
        act(() => setup.mockInput.pressKey("b"));
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Confirm rollback")
        );
        act(() => {
          setup.mockInput.pressKey("s");
          setup.mockInput.pressKey("y");
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Updating plan…")
          )
        ).toBe(true);
        expect(start).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("n"));
        await settle(
          setup.renderOnce,
          () => !setup.captureCharFrame().includes("Confirm rollback")
        );
        const args = prepare.mock.calls[1];
        if (args === undefined) {
          throw new Error("Expected plan refresh");
        }
        const updated = await base.prepare(...args);
        await act(async () => {
          pending.resolve(updated);
          await setup.renderOnce();
        });
        expect(setup.captureCharFrame()).not.toContain("Confirm rollback");
        expect(start).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps rollback plan errors in the dialog and requires a successful retry before confirming",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/transitive-dependency.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      let failed = false;
      const prepare = vi.fn<MigrationTuiRuntime["prepare"]>(
        (selection, action, options) => {
          if (options?.withDependencies === false && !failed) {
            failed = true;
            return Promise.reject(new Error("Plan unavailable"));
          }
          return base.prepare(selection, action, options);
        }
      );
      const start = vi.fn(base.start);
      const setup = await createTestRenderer({ height: 24, width: 72 });
      const root = createRoot(setup.renderer);
      act(() =>
        root.render(<MigrationTuiApp runtime={{ ...base, prepare, start }} />)
      );
      try {
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Status reloaded")
        );
        act(() => setup.mockInput.pressKey("b"));
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Confirm rollback")
        );
        act(() => setup.mockInput.pressKey("s"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Plan unavailable")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("y"));
        await act(async () => setup.renderOnce());
        expect(start).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("s"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("● s Selected only")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("Plan unavailable");
        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => start.mock.calls.length === 1)
        ).toBe(true);
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({
              executionDefinitionIds: ["authors"],
              force: false,
              withDependencies: false,
            }),
          })
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "defaults to recommended rollback scope and allows selected-only without force when dependents are empty",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/transitive-dependency.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const prepare = vi.spyOn(runtime, "prepare");
      const start = vi.spyOn(runtime, "start");
      const setup = await createTestRenderer({ height: 30, width: 100 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Status reloaded")
        );
        act(() => setup.mockInput.pressKey("b"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("3. ○ authors")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain(
          "● i Include dependencies (recommended)"
        );
        expect(setup.captureCharFrame()).toContain("○ s Selected only");
        expect(setup.captureCharFrame()).toContain("3. ○ authors");
        expect(setup.captureCharFrame()).not.toContain("Force rollback");
        expect(prepare).toHaveBeenLastCalledWith(
          expect.anything(),
          "rollback",
          {
            force: false,
            withDependencies: true,
          }
        );
        const lines = setup.captureCharFrame().split("\n");
        const choiceY = lines.findIndex((line) =>
          line.includes("○ s Selected only")
        );
        const choiceX = lines[choiceY]?.indexOf("○ s Selected only") ?? -1;
        expect(choiceX).toBeGreaterThanOrEqual(0);
        await act(async () => setup.mockMouse.click(choiceX + 5, choiceY));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("● s Selected only")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain(
          "○ i Include dependencies (recommended)"
        );
        expect(setup.captureCharFrame()).toMatch(rollbackAuthorsRowPattern);
        expect(setup.captureCharFrame()).not.toContain("UNSAFE");
        expect(setup.captureCharFrame()).not.toContain("references may break");
        expect(start).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => start.mock.calls.length === 1)
        ).toBe(true);
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({
              executionDefinitionIds: ["authors"],
              force: false,
              withDependencies: false,
            }),
          })
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "explains and confirms the complete rollback scope once in execution order",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/transitive-dependency.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const start = vi.spyOn(runtime, "start");
      const prepare = vi.spyOn(runtime, "prepare");
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("b"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Confirm rollback")
          )
        ).toBe(true);

        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("3. ○ authors")
          )
        ).toBe(true);
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Rollback migrations with dependencies");
        expect(frame).toContain("○ s Selected only");
        expect(frame).toContain("Rollback order");
        expect(frame).toContain("1. ○ pages");
        expect(frame).toContain("2. ○ articles");
        expect(frame).toContain("3. ○ authors");
        expect(frame).toContain("y Rollback selected");
        expect(prepare).toHaveBeenLastCalledWith(
          expect.anything(),
          "rollback",
          { force: false, withDependencies: true }
        );
        expect(start).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => start.mock.calls.length === 1)
        ).toBe(true);
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({
              executionDefinitionIds: ["pages", "articles", "authors"],
              withDependencies: true,
            }),
          })
        );
        expect(prepare).toHaveBeenCalledTimes(1);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "confirms an explicit selected-only override once with its consequences",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/transitive-dependency.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const forward = await runtime.prepare({ kind: "all" }, "run");
      const forwardRun = await runtime.start(forward);
      await runtime.observeRun(forwardRun.runId);
      const prepare = vi.spyOn(runtime, "prepare");
      const start = vi.spyOn(runtime, "start");
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("b"));
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Confirm rollback")
        );
        act(() => setup.mockInput.pressKey("s"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("● s Selected only")
          )
        ).toBe(true);
        const frame = setup.captureCharFrame();
        expect(frame).toContain("UNSAFE");
        expect(frame).toContain("Rollback selected migration only");
        expect(frame).toContain(
          "Dependent records remain; references may break."
        );
        expect(frame).toContain("y Rollback selected");
        expect(frame).toMatch(rollbackAuthorsRowPattern);
        expect(frame).not.toContain("2. ○ articles");
        expect(prepare).toHaveBeenLastCalledWith(
          {
            definitionIds: [toMigrationDefinitionId("authors")],
            kind: "definitions",
          },
          "rollback",
          { force: true, withDependencies: false }
        );
        act(() => setup.mockInput.pressKey("i"));
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes("● i Include dependencies (recommended)")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("UNSAFE");
        expect(prepare).toHaveBeenLastCalledWith(
          expect.anything(),
          "rollback",
          {
            force: false,
            withDependencies: true,
          }
        );
        act(() => setup.mockInput.pressKey("s"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("● s Selected only")
          )
        ).toBe(true);
        act(() => setup.resize(72, 24));
        await act(async () => setup.renderOnce());
        const narrowFrame = setup.captureCharFrame();
        expect(narrowFrame).toContain(
          "Dependent records remain; references may break."
        );
        expect(narrowFrame).toContain("y Rollback selected");
        expect(start).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => start.mock.calls.length === 1)
        ).toBe(true);
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            plan: expect.objectContaining({
              executionDefinitionIds: ["authors"],
              force: true,
              withDependencies: false,
            }),
          })
        );
        expect(prepare).toHaveBeenCalledTimes(6);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps rollback controls fixed while a large hierarchy scrolls",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/large-rollback.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 24, width: 72 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MigrationTuiApp runtime={runtime} />));

      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);

        act(() => setup.mockInput.pressKey("b"));
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("Confirm rollback")
        );
        act(() => setup.mockInput.pressKey("i"));
        await settle(setup.renderOnce, () =>
          setup
            .captureCharFrame()
            .includes("● i Include dependencies (recommended)")
        );
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Confirm rollback") &&
              frame.includes("i include · s selected only · y confirm")
            );
          })
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("17. ○ migration-02");

        for (let index = 0; index < 20; index += 1) {
          act(() => {
            setup.mockInput.pressArrow("down");
          });
          await act(async () => setup.renderOnce());
        }
        expect(setup.captureCharFrame()).toContain("17. ○ migration-02");
        expect(setup.captureCharFrame()).toContain(
          "i include · s selected only · y confirm"
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );
  itWithOpenTui(
    "returns rolled-back migrations to not run and shows the full run plan",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("rollback-readiness.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("r"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("authors  COMPLETE")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("b"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("y Rollback selected")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("authors  NOT RUN") &&
              frame.includes("rollback succeeded")
            );
          })
        ).toBe(true);
        act(() => setup.mockInput.pressArrow("down"));
        act(() => setup.mockInput.pressKey("r"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Dependencies incomplete")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("1. ○ authors");
        expect(setup.captureCharFrame()).toContain("2. ○ articles");
        act(() => setup.resize(72, 24));
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("1. ○ authors");
        expect(setup.captureCharFrame()).toContain("2. ○ articles");
        expect(setup.captureCharFrame()).toContain("i Include dependencies");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );
});
