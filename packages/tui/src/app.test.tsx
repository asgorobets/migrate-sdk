import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";
import {
  MigrationExecutable,
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
  type MigrateDashboardRow,
  type MigrateDefinitionSourceItemTotal,
  type MigrateRunStartResult,
  type MigrateSourceIdentityHistoryEntry,
  type MigrateStoreSchemaPlan,
  type MigrateTarget,
} from "migrate-sdk/protocol";
import {
  loadLocalMigrateServerRuntime,
  type MigrateServerExecutionHandle,
  type MigrateServerExecutionResult,
  makeRegistryMigrateServerRuntime,
} from "migrate-sdk/server";
import { act, useState } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeLimitedRunConfig } from "../examples/limited-run.config.ts";
import { MigrationTuiApp as MigrationTuiAppView } from "./app.tsx";
import type { MigrationTuiExecutionResult } from "./execution.ts";
import {
  type MigrationTuiRenderSessionInput,
  makeMigrationTuiLifecycleSupervisor,
} from "./lifecycle-supervisor.ts";
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
  loadStatusOnStartup = true,
  runtime,
}: {
  readonly loadStatusOnStartup?: boolean;
  readonly runtime: MigrationTuiRuntime;
}) => (
  <MigrationTuiAppView
    lifecycle={{
      executionSettled: () => false,
      isExitRequested: () => false,
      requestExit: runtime.detachForExit,
    }}
    loadStatusOnStartup={loadStatusOnStartup}
    runtime={runtime}
  />
);

const makeInProcessMigrationTuiRuntime = async (
  input: Parameters<typeof loadLocalMigrateServerRuntime>[0] & {
    readonly registry?: Parameters<
      typeof makeRegistryMigrateServerRuntime
    >[0]["registry"];
  }
): Promise<MigrationTuiRuntime> => {
  const server =
    input.registry === undefined
      ? await Effect.runPromise(
          Effect.scoped(loadLocalMigrateServerRuntime(input))
        )
      : makeRegistryMigrateServerRuntime({
          registry: input.registry,
          executable: MigrationExecutable.inlineService,
        });
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
    environmentLabel: basename(input.configPath ?? "test-registry"),
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

const readySelectiveDialog = async (
  setup: Awaited<ReturnType<typeof createTestRenderer>>
) => {
  expect(
    await settle(setup.renderOnce, () =>
      setup.captureCharFrame().includes("Run selected entries")
    )
  ).toBe(true);
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  });
  await act(async () => setup.renderOnce());
};

const switchSelectionMethod = async (
  setup: Awaited<ReturnType<typeof createTestRenderer>>,
  mode: "Next items" | "Source IDs"
) => {
  if (setup.captureCharFrame().includes(`[ ${mode} ]`)) {
    return;
  }
  act(() => setup.mockInput.pressTab({ shift: true }));
  await act(async () => setup.renderOnce());
  act(() =>
    setup.mockInput.pressArrow(mode === "Source IDs" ? "right" : "left")
  );
  expect(
    await settle(setup.renderOnce, () =>
      setup.captureCharFrame().includes(`[ ${mode} ]`)
    )
  ).toBe(true);
  act(() => setup.mockInput.pressTab());
  await act(async () => setup.renderOnce());
};

const chooseSourceIds = async (
  setup: Awaited<ReturnType<typeof createTestRenderer>>
) => {
  await readySelectiveDialog(setup);
  await switchSelectionMethod(setup, "Source IDs");
};

const withActiveAuthorsRun = (
  snapshot: MigrationTuiSnapshot
): MigrationTuiSnapshot => {
  const runId = toMigrationRunId("observed-test-run");
  const definitionId = toMigrationDefinitionId("authors");
  const startedAt = new Date("2026-09-17T12:00:00Z");
  return {
    ...snapshot,
    activeRuns: [
      {
        runId,
        definitionIds: [definitionId],
        observationDefinitionId: definitionId,
        status: "running",
        startedAt,
        stopSupported: true,
      },
    ],
    rows: snapshot.rows.map((row) =>
      row.entry.id !== definitionId || row.status === undefined
        ? row
        : {
            ...row,
            status: {
              ...row.status,
              lock: {
                definitionId,
                ownerRunId: runId,
                token: toMigrationDefinitionLockToken("observed-test-lock"),
                createdAt: startedAt,
              },
            },
          }
    ),
  };
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
    "keeps migrations usable while status loads and stops observing when idle",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const snapshot = await base.refresh();
      const pendingStatus = Promise.withResolvers<void>();
      const pendingPreparation =
        Promise.withResolvers<
          Awaited<ReturnType<MigrationTuiRuntime["prepare"]>>
        >();
      let observationSignal: AbortSignal | undefined;
      const observeDashboard = vi.fn<MigrationTuiRuntime["observeDashboard"]>(
        async ({ onSnapshot, signal }) => {
          observationSignal = signal;
          await pendingStatus.promise;
          onSnapshot(snapshot);
        }
      );
      const prepare = vi.fn(() => pendingPreparation.promise);
      const runtime: MigrationTuiRuntime = {
        ...base,
        observeDashboard,
        prepare,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("authors");
        expect(setup.captureCharFrame()).toContain("Loading status…");
        expect(setup.captureCharFrame()).toContain("NOT LOADED");
        expect(setup.captureCharFrame()).toContain("Run history not loaded");
        expect(setup.captureCharFrame()).toContain("Incremental: not loaded");
        expect(setup.captureCharFrame()).not.toContain("never run");
        expect(setup.captureCharFrame()).not.toContain("0 / 4");
        act(() => setup.mockInput.pressKey("r"));
        expect(
          await settle(setup.renderOnce, () => prepare.mock.calls.length === 1)
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("Preparing");
        await act(async () => {
          pendingStatus.resolve();
          await pendingStatus.promise;
        });
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("Preparing");
        expect(observationSignal?.aborted).toBe(true);
        expect(observeDashboard).toHaveBeenCalledOnce();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "defers manual status until R, coalesces reloads, and allows retry after failure",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const snapshot = await base.refresh();
      const pending = Promise.withResolvers<MigrationTuiSnapshot>();
      const refresh = vi
        .fn<MigrationTuiRuntime["refresh"]>()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(snapshot);
      const observeDashboard = vi.fn(base.observeDashboard.bind(base));
      const runtime: MigrationTuiRuntime = {
        ...base,
        refresh,
        observeDashboard,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);
      act(() =>
        root.render(
          <MigrationTuiApp loadStatusOnStartup={false} runtime={runtime} />
        )
      );
      try {
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("Status not loaded");
        expect(setup.captureCharFrame()).not.toContain("Loading status…");
        expect(refresh).not.toHaveBeenCalled();
        expect(observeDashboard).not.toHaveBeenCalled();
        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () => refresh.mock.calls.length === 1)
        ).toBe(true);
        act(() => setup.mockInput.pressKey("r", { shift: true }));
        await act(async () => setup.renderOnce());
        expect(refresh).toHaveBeenCalledOnce();
        act(() => {
          pending.reject(new Error("Store unavailable"));
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Press R to retry")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("Loading status…");
        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(observeDashboard).not.toHaveBeenCalled();
        expect(setup.captureCharFrame()).not.toContain("Store unavailable");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "shows unloaded history and discovery until status is requested",
    async () => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const snapshot = await base.refresh();
      const pending = Promise.withResolvers<MigrationTuiSnapshot>();
      const refresh = vi
        .fn<MigrationTuiRuntime["refresh"]>()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue({
          ...snapshot,
          rows: snapshot.rows.map((row) =>
            row.status === undefined
              ? row
              : { ...row, status: { ...row.status, lastRun: null } }
          ),
        });
      const runtime = { ...base, refresh };
      const setup = await createTestRenderer({ height: 30, width: 140 });
      const root = createRoot(setup.renderer);
      act(() =>
        root.render(
          <MigrationTuiApp loadStatusOnStartup={false} runtime={runtime} />
        )
      );
      try {
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).not.toContain("never run");
        expect(setup.captureCharFrame()).toContain("Run history not loaded");
        expect(setup.captureCharFrame()).toContain("Incremental: not loaded");
        expect(refresh).not.toHaveBeenCalled();

        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () => refresh.mock.calls.length === 1)
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("never run");
        expect(setup.captureCharFrame()).toContain("Incremental: not loaded");

        await act(async () => {
          pending.resolve({
            ...snapshot,
            rows: snapshot.rows.map((row) =>
              row.status === undefined
                ? row
                : {
                    ...row,
                    status: { ...row.status, discovery: "incremental" },
                  }
            ),
          });
          await pending.promise;
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("run succeeded");
        expect(setup.captureCharFrame()).toContain("✓ Incremental");
        expect(setup.captureCharFrame()).not.toContain(
          "Run history not loaded"
        );
        expect(setup.captureCharFrame()).not.toContain(
          "Incremental: not loaded"
        );

        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("never run")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("✓ Incremental");
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

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
        expect(refresh).not.toHaveBeenCalled();
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

  itWithOpenTui.each(["unloaded", "idle", "active", "pending"] as const)(
    "recovers a manual session without a hidden status read (%s)",
    async (mode) => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const idle = await base.refresh();
      const running = withActiveAuthorsRun(idle);
      const pending = Promise.withResolvers<MigrationTuiSnapshot>();
      const refresh = vi.fn(() =>
        mode === "pending"
          ? pending.promise
          : Promise.resolve(mode === "active" ? running : idle)
      );
      const observers: MigrationTuiDashboardObservationOptions[] = [];
      const observeDashboard = vi.fn<MigrationTuiRuntime["observeDashboard"]>(
        async (options) => {
          observers.push(options);
          if (observers.length === 1) {
            options.onSnapshot(mode === "active" ? running : idle);
          }
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
            } else {
              options.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          });
        }
      );
      const runtime = {
        ...base,
        refresh,
        observeDashboard,
        observeRun: () =>
          new Promise<MigrationTuiExecutionResult>(() => undefined),
      };
      const sessions: {
        readonly input: MigrationTuiRenderSessionInput;
        readonly setup: Awaited<ReturnType<typeof createTestRenderer>>;
      }[] = [];
      const supervisor = makeMigrationTuiLifecycleSupervisor({
        runtime,
        createSession: async (input) => {
          const setup = await createTestRenderer({ height: 30, width: 120 });
          const root = createRoot(setup.renderer);
          act(() =>
            root.render(
              <MigrationTuiAppView
                {...input}
                loadStatusOnStartup={false}
                runtime={runtime}
              />
            )
          );
          sessions.push({ input, setup });
          return {
            destroy: () => {
              act(() => root.unmount());
              setup.renderer.destroy();
            },
          };
        },
        forceExit: vi.fn(),
        setExitCode: vi.fn(),
        signalSource: { on: vi.fn(), off: vi.fn() },
        writeError: vi.fn(),
      });
      try {
        await supervisor.start();
        const first = sessions[0];
        if (first === undefined) {
          throw new Error("Expected initial renderer");
        }
        await act(async () => first.setup.renderOnce());
        if (mode !== "unloaded") {
          act(() => first.setup.mockInput.pressKey("r", { shift: true }));
          expect(
            await settle(first.setup.renderOnce, () => {
              if (mode === "pending") {
                return refresh.mock.calls.length === 1;
              }
              return first.setup
                .captureCharFrame()
                .includes(mode === "active" ? "v View run" : "Status reloaded");
            })
          ).toBe(true);
        }
        first.input.onRenderError(new Error("Recover this renderer"));
        expect(
          await settle(
            async () => undefined,
            () => sessions.length === 2
          )
        ).toBe(true);
        const recovered = sessions[1];
        if (recovered === undefined) {
          throw new Error("Expected recovered renderer");
        }
        await act(async () => recovered.setup.renderOnce());
        expect(recovered.setup.captureCharFrame()).toContain("authors");
        expect(recovered.setup.captureCharFrame()).toContain("UI recovered");
        expect(refresh).toHaveBeenCalledTimes(mode === "unloaded" ? 0 : 1);
        if (mode === "active") {
          expect(observeDashboard).toHaveBeenCalledTimes(2);
          expect(recovered.setup.captureCharFrame()).toContain("v View run");
          expect(recovered.setup.captureCharFrame()).toContain("x Stop");
          act(() => observers[1]?.onSnapshot(idle));
          expect(
            await settle(
              recovered.setup.renderOnce,
              () => !recovered.setup.captureCharFrame().includes("v View run")
            )
          ).toBe(true);
          expect(observers[1]?.signal?.aborted).toBe(true);
        } else if (mode === "pending") {
          expect(observeDashboard).toHaveBeenCalledOnce();
          await act(async () => {
            pending.resolve(running);
            await pending.promise;
          });
          await act(async () => recovered.setup.renderOnce());
          expect(recovered.setup.captureCharFrame()).not.toContain(
            "v View run"
          );
          expect(recovered.setup.captureCharFrame()).toContain("run succeeded");
        } else {
          expect(observeDashboard).not.toHaveBeenCalled();
          expect(recovered.setup.captureCharFrame()).toContain(
            mode === "unloaded" ? "Status not loaded" : "run succeeded"
          );
        }
      } finally {
        await supervisor.lifecycle.requestExit();
      }
    }
  );

  itWithOpenTui.each([
    { loadStatusOnStartup: false, group: false },
    { loadStatusOnStartup: true, group: false },
    { loadStatusOnStartup: false, group: true },
    { loadStatusOnStartup: true, group: true },
  ])(
    "resumes live updates when a source scan discovers a run (%o)",
    async ({ loadStatusOnStartup, group }) => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const idle = await base.refresh();
      const running = withActiveAuthorsRun(idle);
      const scanSource = vi.fn(async () => running);
      let publish:
        | MigrationTuiDashboardObservationOptions["onSnapshot"]
        | undefined;
      let signal: AbortSignal | undefined;
      const observeDashboard = vi.fn<MigrationTuiRuntime["observeDashboard"]>(
        async (options) => {
          publish = options.onSnapshot;
          signal = options.signal;
          options.onSnapshot(
            scanSource.mock.calls.length === 0 ? idle : running
          );
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) {
              resolve();
            } else {
              options.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          });
        }
      );
      const runtime = {
        ...base,
        scanSource,
        observeDashboard,
        observeRun: () =>
          new Promise<MigrationTuiExecutionResult>(() => undefined),
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);
      act(() =>
        root.render(
          <MigrationTuiApp
            loadStatusOnStartup={loadStatusOnStartup}
            runtime={runtime}
          />
        )
      );
      try {
        await act(async () => setup.renderOnce());
        const initialCalls = loadStatusOnStartup ? 1 : 0;
        expect(observeDashboard).toHaveBeenCalledTimes(initialCalls);
        if (group) {
          act(() => setup.mockInput.pressKey("g"));
          await act(async () => setup.renderOnce());
        }
        act(() => setup.mockInput.pressKey("s"));
        await settle(setup.renderOnce, () =>
          setup.captureCharFrame().includes("v View run")
        );
        expect(setup.captureCharFrame()).toContain("v View run");
        expect(setup.captureCharFrame()).toContain("x Stop");
        expect(observeDashboard).toHaveBeenCalledTimes(initialCalls + 1);
        act(() => publish?.(idle));
        expect(
          await settle(
            setup.renderOnce,
            () => !setup.captureCharFrame().includes("v View run")
          )
        ).toBe(true);
        expect(signal?.aborted).toBe(true);
        expect(observeDashboard).toHaveBeenCalledTimes(initialCalls + 1);
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "applies a manual durable refresh without restarting idle observation",
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
              observeDashboard.mock.calls.length === 1
          )
        ).toBe(true);
        expect(refresh).toHaveBeenCalledOnce();
        expect(observeDashboard.mock.calls[0]?.[0].signal?.aborted).toBe(true);
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
              frame.includes("4 RETAINED") &&
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
            setup.captureCharFrame().includes("Event 4")
          )
        ).toBe(true);

        act(() => setup.resize(72, 24));
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Session activity") &&
              frame.includes("e export JSONL") &&
              frame.includes("Event 4")
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
    "records lifecycle changes for external runs discovered while active",
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
            activeRuns: [{ ...activeRun, status: "queued" }],
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
      const diagnostic = [
        "ACTIVITY-START",
        ...Array.from({ length: 30 }, (_, index) => `Diagnostic line ${index}`),
        "ACTIVITY-END",
      ].join("\n");
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        observeDashboard: () => Promise.reject(new Error(diagnostic)),
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
    "loads messages on demand and reuses migration and group caches",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const firstRequest = Promise.withResolvers<readonly MigrationMessage[]>();
      const listMessages = vi
        .fn<MigrationTuiRuntime["listMessages"]>()
        .mockImplementationOnce(() => firstRequest.promise)
        .mockResolvedValue([]);
      const runtime = { ...baseRuntime, listMessages };
      const setup = await createTestRenderer({
        height: 36,
        kittyKeyboard: true,
        width: 120,
      });
      const root = createRoot(setup.renderer);
      const press = async (key: string) => {
        await act(async () => {
          setup.mockInput.pressKey(key);
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          await setup.renderOnce();
        });
      };

      act(() =>
        root.render(
          <MigrationTuiApp loadStatusOnStartup={false} runtime={runtime} />
        )
      );
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Messages not loaded · m to load")
          )
        ).toBe(true);
        await press("j");
        await press("g");
        expect(listMessages).not.toHaveBeenCalled();
        expect(setup.captureCharFrame()).not.toContain("Messages 0");

        await press("m");
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Loading messages…")
          )
        ).toBe(true);
        expect(listMessages).toHaveBeenCalledWith({
          kind: "group",
          groupId: "content",
        });
        await press("m");
        expect(listMessages).toHaveBeenCalledTimes(1);
        firstRequest.resolve([]);
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("No messages.")
          )
        ).toBe(true);

        await press("ESCAPE");
        await press("g");
        await press("m");
        expect(listMessages).toHaveBeenLastCalledWith({
          kind: "migration",
          definitionId: "authors",
        });
        await press("ESCAPE");
        await press("j");
        await press("m");
        expect(listMessages).toHaveBeenLastCalledWith({
          kind: "migration",
          definitionId: "articles",
        });
        await press("ESCAPE");
        await press("k");
        await press("m");
        expect(setup.captureCharFrame()).toContain("No messages.");
        await press("ESCAPE");
        await press("g");
        await press("m");
        expect(setup.captureCharFrame()).toContain("No messages.");
        expect(listMessages).toHaveBeenCalledTimes(3);
      } finally {
        firstRequest.resolve([]);
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
        readonly status: string;
        readonly messages: readonly MigrationMessage[];
        readonly target: string;
      }> = [];
      let load = () => Promise.resolve();
      let select:
        | ((target: typeof authorsTarget | typeof articlesTarget) => void)
        | undefined;
      const MessageSnapshot = () => {
        const [target, setTarget] = useState<
          typeof authorsTarget | typeof articlesTarget
        >(authorsTarget);
        select = setTarget;
        const snapshot = useMigrationMessages({
          rows: [],
          runtime,
          setError,
          target,
        });
        load = snapshot.load;
        snapshots.push({ ...snapshot, target: target.definitionId });
        return <box />;
      };
      const setup = await createTestRenderer({ height: 5, width: 40 });
      const root = createRoot(setup.renderer);

      act(() => root.render(<MessageSnapshot />));

      try {
        await act(() => load());
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
        act(() => select?.(articlesTarget));

        expect(snapshots[0]).toMatchObject({
          status: "not-loaded",
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
    "invalidates only affected message caches when durable progress changes",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const rows = (await baseRuntime.refresh()).rows;
      const authors = {
        kind: "migration",
        definitionId: toMigrationDefinitionId("authors"),
      } as const;
      const articles = {
        kind: "migration",
        definitionId: toMigrationDefinitionId("articles"),
      } as const;
      const group = baseRuntime.groups[0];
      if (group === undefined) {
        throw new Error("Missing fixture group");
      }
      const content = { kind: "group", groupId: group.id } as const;
      const listMessages = vi
        .fn<MigrationTuiRuntime["listMessages"]>()
        .mockResolvedValue([]);
      const runtime = { listMessages };
      const setError = vi.fn();
      let snapshot: ReturnType<typeof useMigrationMessages> | undefined;
      interface ProbeInput {
        readonly currentRows: readonly MigrateDashboardRow[];
        readonly target: MigrateTarget;
      }
      let update: ((input: ProbeInput) => void) | undefined;
      const Probe = () => {
        const [input, setInput] = useState<ProbeInput>({
          currentRows: rows,
          target: authors,
        });
        const { currentRows, target } = input;
        update = setInput;
        snapshot = useMigrationMessages({
          rows: currentRows,
          runtime,
          setError,
          target,
        });
        return <box />;
      };
      const setup = await createTestRenderer({ height: 5, width: 40 });
      const root = createRoot(setup.renderer);
      const render = async (
        currentRows: readonly MigrateDashboardRow[],
        target: MigrateTarget
      ) =>
        act(async () => {
          update?.({ currentRows, target });
          await setup.renderOnce();
        });
      act(() => root.render(<Probe />));
      try {
        for (const target of [authors, articles, content]) {
          await render(rows, target);
          expect(snapshot?.status).toBe("not-loaded");
          await act(async () => {
            await snapshot?.load();
          });
          expect(snapshot?.status).toBe("loaded");
        }
        expect(listMessages).toHaveBeenCalledTimes(3);

        const sourceRows = rows.map((row) =>
          row.status === undefined
            ? row
            : {
                ...row,
                status: {
                  ...row.status,
                  source: {
                    total: 99,
                    unprocessed: 99,
                    invalid: 0,
                    duplicate: 0,
                    orphaned: 0,
                  },
                },
              }
        );
        await render(sourceRows, content);
        await act(async () => {
          await snapshot?.load();
        });
        expect(snapshot?.status).toBe("loaded");
        expect(listMessages).toHaveBeenCalledTimes(3);

        const changedRows = rows.map((row) =>
          row.entry.id !== authors.definitionId || row.status === undefined
            ? row
            : {
                ...row,
                status: {
                  ...row.status,
                  durable: {
                    ...row.status.durable,
                    failed: row.status.durable.failed + 1,
                  },
                },
              }
        );
        await render(changedRows, articles);
        await act(async () => {
          await snapshot?.load();
        });
        expect(snapshot?.status).toBe("loaded");
        await render(changedRows, content);
        expect(snapshot?.status).toBe("stale");
        await render(changedRows, authors);
        expect(snapshot?.status).toBe("stale");
        expect(listMessages).toHaveBeenCalledTimes(3);
        // Counts returning to A while another migration is selected must not
        // revive either the migration cache or its group cache.
        await render(rows, articles);
        expect(snapshot?.status).toBe("loaded");
        await render(rows, authors);
        expect(snapshot?.status).toBe("stale");
        await render(rows, content);
        expect(snapshot?.status).toBe("stale");
        await render(changedRows, authors);
        await act(async () => {
          await snapshot?.load();
        });
        expect(snapshot?.status).toBe("loaded");
        await render(changedRows, content);
        await act(async () => {
          await snapshot?.load();
        });
        expect(listMessages).toHaveBeenCalledTimes(5);

        // A new attempt may replace diagnostic text without changing counts.
        const newRunRows = changedRows.map((row) =>
          row.entry.id !== authors.definitionId || row.status === undefined
            ? row
            : {
                ...row,
                status: {
                  ...row.status,
                  lastRun: {
                    definitionId: authors.definitionId,
                    definitionIds: [authors.definitionId],
                    runId: toMigrationRunId("new-message-attempt"),
                    startedAt: new Date("2026-09-17T12:00:00Z"),
                    finishedAt: new Date("2026-09-17T12:00:01Z"),
                    status: "succeeded" as const,
                    runStatus: "succeeded" as const,
                  },
                },
              }
        );
        await render(newRunRows, authors);
        expect(snapshot?.status).toBe("stale");
        await render(newRunRows, content);
        expect(snapshot?.status).toBe("stale");
        expect(listMessages).toHaveBeenCalledTimes(5);
        expect(setError).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "keeps late message responses stale and lets failed loads retry",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const rows = (await baseRuntime.refresh()).rows;
      const target = {
        kind: "migration",
        definitionId: toMigrationDefinitionId("authors"),
      } as const;
      const pending = Promise.withResolvers<readonly MigrationMessage[]>();
      const listMessages = vi
        .fn<MigrationTuiRuntime["listMessages"]>()
        .mockImplementationOnce(() => pending.promise)
        .mockRejectedValueOnce(new Error("Message store unavailable"))
        .mockResolvedValue([]);
      const runtime = { listMessages };
      const setError = vi.fn();
      let snapshot: ReturnType<typeof useMigrationMessages> | undefined;
      interface ProbeInput {
        readonly currentRows: readonly MigrateDashboardRow[];
        readonly currentRuntime: Pick<MigrationTuiRuntime, "listMessages">;
      }
      let update: ((input: ProbeInput) => void) | undefined;
      const Probe = () => {
        const [input, setInput] = useState<ProbeInput>({
          currentRows: rows,
          currentRuntime: runtime,
        });
        const { currentRows, currentRuntime } = input;
        update = setInput;
        snapshot = useMigrationMessages({
          rows: currentRows,
          runtime: currentRuntime,
          setError,
          target,
        });
        return <box />;
      };
      const setup = await createTestRenderer({ height: 5, width: 40 });
      const root = createRoot(setup.renderer);
      try {
        await act(async () => {
          root.render(<Probe />);
          await setup.renderOnce();
        });
        let loading: Promise<void> | undefined;
        act(() => {
          loading = snapshot?.load();
        });
        const changedRows = rows.map((row) =>
          row.entry.id !== target.definitionId || row.status === undefined
            ? row
            : {
                ...row,
                status: {
                  ...row.status,
                  durable: {
                    ...row.status.durable,
                    failed: row.status.durable.failed + 1,
                  },
                },
              }
        );
        await act(async () => {
          update?.({ currentRows: changedRows, currentRuntime: runtime });
          await setup.renderOnce();
        });
        // Even an A -> B -> A transition while the read is pending must
        // invalidate its eventual response.
        await act(async () => {
          update?.({ currentRows: rows, currentRuntime: runtime });
          await setup.renderOnce();
        });
        await act(async () => {
          pending.resolve([]);
          await loading;
        });
        expect(snapshot?.status).toBe("stale");
        expect(listMessages).toHaveBeenCalledTimes(1);

        await act(async () => {
          await snapshot?.load();
        });
        expect(snapshot?.status).toBe("error");
        expect(setError).toHaveBeenCalledWith("Message store unavailable");
        await act(async () => {
          await snapshot?.load();
        });
        expect(snapshot?.status).toBe("loaded");
        expect(listMessages).toHaveBeenCalledTimes(3);

        const replacement = {
          listMessages: vi
            .fn<MigrationTuiRuntime["listMessages"]>()
            .mockResolvedValue([]),
        };
        await act(async () => {
          update?.({ currentRows: changedRows, currentRuntime: replacement });
          await setup.renderOnce();
        });
        expect(snapshot?.status).toBe("not-loaded");
        expect(replacement.listMessages).not.toHaveBeenCalled();
        await act(async () => {
          await snapshot?.load();
        });
        expect(snapshot?.status).toBe("loaded");
        expect(replacement.listMessages).toHaveBeenCalledTimes(1);
      } finally {
        pending.resolve([]);
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  for (const selection of ["migration", "group"] as const) {
    itWithOpenTui(
      `keeps expanded ${selection} messages readable when their cache is invalidated`,
      async () => {
        const base = await makeInProcessMigrationTuiRuntime({
          configPath: serverFixturePath("migrate.config.ts"),
          cwd: new URL("..", import.meta.url).pathname,
        });
        const durable = await base.refresh();
        const definitionId = toMigrationDefinitionId("authors");
        const activeRun = {
          definitionIds: [definitionId],
          observationDefinitionId: definitionId,
          runId: messageRunId,
          startedAt: new Date("2026-09-17T12:00:00Z"),
          status: "running",
          stopSupported: true,
        } satisfies MigrateActiveRun;
        const messages: readonly MigrationMessage[] = [1, 2].map((number) => ({
          definitionId,
          kind: "skip-reason",
          message: `Original message ${number}`,
          runId: messageRunId,
          severity: "info",
          sourceIdentity: toEncodedSourceIdentity(`item-${number}`),
          updatedAt: new Date("2026-09-17T12:00:00Z"),
        }));
        const listMessages = vi
          .fn<MigrationTuiRuntime["listMessages"]>()
          .mockResolvedValueOnce(messages)
          .mockResolvedValue(
            messages.map((message) => ({
              ...message,
              message: "Fresh message",
            }))
          );
        let publish:
          | MigrationTuiDashboardObservationOptions["onSnapshot"]
          | undefined;
        const runtime: MigrationTuiRuntime = {
          ...base,
          listMessages,
          observeDashboard: async ({ onSnapshot, signal }) => {
            publish = onSnapshot;
            onSnapshot({ ...durable, activeRuns: [activeRun] });
            await new Promise<void>((resolve) => {
              if (signal?.aborted === true) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          },
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
          if (selection === "group") {
            act(() => setup.mockInput.pressKey("g"));
          }
          act(() => setup.mockInput.pressKey("m"));
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Message 1 of 2")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressKey("j"));
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("↵ Close")
            )
          ).toBe(true);
          expect(setup.captureCharFrame()).toContain("Message 2 of 2");
          act(() =>
            publish?.({
              ...durable,
              activeRuns: [],
              resumeToken:
                MigrateDashboardResumeToken.make("messages:finished"),
              rows: durable.rows.map((row) =>
                row.entry.id !== definitionId || row.status === undefined
                  ? row
                  : {
                      ...row,
                      status: {
                        ...row.status,
                        durable: {
                          ...row.status.durable,
                          failed: row.status.durable.failed + 1,
                        },
                      },
                    }
              ),
            })
          );
          await act(async () => {
            await setup.renderOnce();
          });
          expect(setup.captureCharFrame()).toContain("↵ Close");
          expect(setup.captureCharFrame()).toContain("Message 2 of 2");
          expect(setup.captureCharFrame()).toContain("Original message 2");
          act(() => setup.mockInput.pressEscape());
          expect(
            await settle(setup.renderOnce, () =>
              setup
                .captureCharFrame()
                .includes("Messages may have changed · m to reload")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressKey("m"));
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Fresh message")
            )
          ).toBe(true);
          expect(listMessages).toHaveBeenCalledTimes(2);
          act(() => setup.mockInput.pressEscape());
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("[ Overview ]")
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
              frame.includes("Source scan complete") &&
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

  itWithOpenTui.each([false, true])(
    "keeps earlier source scans when scanning an unrelated migration (background: %s)",
    async (loadStatusOnStartup) => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("migrate.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const scanSource = vi.fn(base.scanSource);
      const runtime = { ...base, scanSource };
      const setup = await createTestRenderer({ height: 36, width: 120 });
      const root = createRoot(setup.renderer);
      const press = async (key: string) => {
        await act(async () => {
          setup.mockInput.pressKey(key);
          await setup.renderOnce();
        });
      };
      const scan = async (definitionId: string, count: number) => {
        await press("s");
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes(`Source scan complete for ${definitionId}`) &&
              frame.includes(`${count} total`)
            );
          })
        ).toBe(true);
      };
      const selectMigration = async (key: string, definitionId: string) => {
        await press(key);
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes(`│ ${definitionId}  `)
          )
        ).toBe(true);
      };
      act(() =>
        root.render(
          <MigrationTuiApp
            loadStatusOnStartup={loadStatusOnStartup}
            runtime={runtime}
          />
        )
      );
      try {
        await act(async () => setup.renderOnce());
        await scan("authors", 2);
        await selectMigration("j", "articles");
        await scan("articles", 2);
        await selectMigration("k", "authors");
        expect(setup.captureCharFrame()).toContain("2 total");
        await selectMigration("j", "articles");
        await selectMigration("j", "assets");
        await scan("assets", 1);
        await selectMigration("k", "articles");
        expect(setup.captureCharFrame()).toContain("2 total");
        expect(setup.captureCharFrame()).not.toContain("Not scanned");
        await selectMigration("k", "authors");
        expect(setup.captureCharFrame()).toContain("2 total");
        await press("g");
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("5 total")
          )
        ).toBe(true);
        expect(scanSource).toHaveBeenCalledTimes(3);
        await press("s");
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes("Source scan complete for content")
          )
        ).toBe(true);
        expect(setup.captureCharFrame()).toContain("5 total");
        expect(scanSource).toHaveBeenCalledTimes(4);
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
            setup.captureCharFrame().includes("Source scan complete")
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
              refresh.mock.calls.length >= 2 &&
              setup.captureCharFrame().includes(`Run ${runId} failed`)
          )
        ).toBe(true);
        expect(observeRun).toHaveBeenCalledWith(runId, expect.any(Object));
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(dashboardObservationCalls).toBe(1);
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
              !frame.includes("Breaking lock for") &&
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

  itWithOpenTui.each(["before", "after"] as const)(
    "refreshes a cleared lock when an older status reload finishes %s the fresh read",
    async (oldResponseOrder) => {
      const base = await makeInProcessMigrationTuiRuntime({
        configPath: serverFixturePath("locked.config.ts"),
        cwd: new URL("..", import.meta.url).pathname,
      });
      const snapshot = await base.refresh();
      const locked: MigrationTuiSnapshot = {
        ...snapshot,
        rows: snapshot.rows.map((row) =>
          row.status === undefined
            ? row
            : {
                ...row,
                status: {
                  ...row.status,
                  lock: {
                    definitionId: row.entry.id,
                    ownerRunId: toMigrationRunId("run-stuck"),
                    token: toMigrationDefinitionLockToken("lock-stuck"),
                    createdAt: new Date("2026-08-23T05:30:00.000Z"),
                  },
                },
              }
        ),
      };
      const fresh: MigrationTuiSnapshot = {
        ...snapshot,
        rows: snapshot.rows.map((row) =>
          row.status === undefined
            ? row
            : { ...row, status: { ...row.status, lock: null } }
        ),
      };
      const breakLock = vi.fn<MigrationTuiRuntime["breakLock"]>(
        async (lock) => ({
          definitionId: lock.definitionId,
          kind: "cleared",
        })
      );
      const pending = Promise.withResolvers<MigrationTuiSnapshot>();
      const pendingFresh = Promise.withResolvers<MigrationTuiSnapshot>();
      const refresh = vi
        .fn<MigrationTuiRuntime["refresh"]>()
        .mockImplementationOnce(() => pending.promise)
        .mockImplementationOnce(() => pendingFresh.promise);
      const runtime: MigrationTuiRuntime = {
        ...base,
        breakLock,
        rows: locked.rows,
        refresh,
      };
      const setup = await createTestRenderer({ height: 30, width: 120 });
      const root = createRoot(setup.renderer);
      act(() =>
        root.render(
          <MigrationTuiApp loadStatusOnStartup={false} runtime={runtime} />
        )
      );
      try {
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).toContain("u Break lock");
        act(() => setup.mockInput.pressKey("r", { shift: true }));
        expect(
          await settle(setup.renderOnce, () => refresh.mock.calls.length === 1)
        ).toBe(true);
        act(() => setup.mockInput.pressKey("u"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Break migration lock")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("y"));
        expect(
          await settle(setup.renderOnce, () => refresh.mock.calls.length === 2)
        ).toBe(true);
        expect(breakLock).toHaveBeenCalledOnce();
        if (oldResponseOrder === "before") {
          await act(async () => {
            pending.resolve(locked);
            await pending.promise;
          });
          await act(async () => setup.renderOnce());
          expect(setup.captureCharFrame()).toContain("Breaking lock for");
        }
        await act(async () => {
          pendingFresh.resolve(fresh);
          await pendingFresh.promise;
        });
        expect(
          await settle(setup.renderOnce, () =>
            setup
              .captureCharFrame()
              .includes("Lock cleared for locked-migration")
          )
        ).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(2);
        expect(setup.captureCharFrame()).not.toContain("u Break lock");

        if (oldResponseOrder === "after") {
          await act(async () => {
            pending.resolve(locked);
            await pending.promise;
          });
        }
        await act(async () => setup.renderOnce());
        expect(setup.captureCharFrame()).not.toContain("u Break lock");
        expect(setup.captureCharFrame()).not.toContain("Owner run  run-stuck");
        expect(setup.captureCharFrame()).toContain(
          "Lock cleared for locked-migration"
        );
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
        expect(concurrencySettings).toContain("Source scan concurrency");
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

  for (const group of [false, true]) {
    itWithOpenTui(
      `runs the next items directly ${group ? "per migration in a group" : "in a single migration"}`,
      async () => {
        const runtime = await makeInProcessMigrationTuiRuntime({
          registry: makeLimitedRunConfig().registry,
          cwd: new URL("..", import.meta.url).pathname,
        });
        const prepare = vi.spyOn(runtime, "prepare");
        const start = vi.spyOn(runtime, "start");
        const history = vi.spyOn(runtime, "listSourceIdentityHistory");
        const setup = await createTestRenderer({ height: 24, width: 72 });
        const root = createRoot(setup.renderer);
        act(() => root.render(<MigrationTuiApp runtime={runtime} />));
        try {
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Status reloaded")
            )
          ).toBe(true);
          if (group) {
            act(() => setup.mockInput.pressKey("g"));
            await act(async () => setup.renderOnce());
          }
          for (let run = 1; run <= 2; run += 1) {
            act(() => setup.mockInput.pressKey("e"));
            await readySelectiveDialog(setup);
            expect(setup.captureCharFrame()).toContain("Items per migration");
            expect(setup.captureCharFrame()).toContain("Run 1 item");
            if (group) {
              expect(setup.captureCharFrame()).not.toContain("Source IDs");
            }
            expect(history).not.toHaveBeenCalled();
            // Edit the input instead of relying on the default to prove the value is read.
            act(() => setup.mockInput.pressBackspace());
            await act(async () => setup.renderOnce());
            await act(async () => setup.mockInput.typeText("1"));
            await act(async () => setup.renderOnce());
            if (group) {
              act(() => setup.mockInput.pressEnter());
            } else {
              const lines = setup.captureCharFrame().split("\n");
              const y = lines.findIndex((line) => line.includes("Run 1 item"));
              const x = lines[y]?.indexOf("Run 1 item") ?? -1;
              expect(x).toBeGreaterThanOrEqual(0);
              await act(async () => setup.mockMouse.click(x + 2, y));
            }
            expect(
              await settle(
                setup.renderOnce,
                () =>
                  setup
                    .captureCharFrame()
                    .includes(`${group ? run * 2 : run} migrated`) &&
                  !setup.captureCharFrame().includes("Stop run")
              )
            ).toBe(true);
            expect(start).toHaveBeenCalledTimes(run);
            expect(setup.captureCharFrame()).not.toContain("Confirm run");
            expect(prepare).toHaveBeenLastCalledWith(
              group
                ? { kind: "group", groupId: "content" }
                : { kind: "definitions", definitionIds: ["authors"] },
              "run",
              { limit: 1 }
            );
            const snapshot = await runtime.refresh();
            expect(
              snapshot.rows.map((row) => row.status?.durable.migrated)
            ).toEqual(group ? [run, run] : [run, 0]);
            expect(start).toHaveBeenLastCalledWith(
              expect.objectContaining({
                request: expect.objectContaining({ options: { limit: 1 } }),
                plan: expect.objectContaining({ limit: 1 }),
              })
            );
          }
        } finally {
          act(() => root.unmount());
          setup.renderer.destroy();
        }
      }
    );
  }

  for (const include of [true, false]) {
    itWithOpenTui(
      `preserves the limit when choosing to ${include ? "include" : "skip"} dependencies`,
      async () => {
        const runtime = await makeInProcessMigrationTuiRuntime({
          registry: makeLimitedRunConfig().registry,
          cwd: new URL("..", import.meta.url).pathname,
        });
        const start = vi.spyOn(runtime, "start");
        const setup = await createTestRenderer({ height: 30, width: 100 });
        const root = createRoot(setup.renderer);
        act(() => root.render(<MigrationTuiApp runtime={runtime} />));
        try {
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Status reloaded")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressArrow("down"));
          await act(async () => setup.renderOnce());
          act(() => setup.mockInput.pressKey("e"));
          await readySelectiveDialog(setup);
          // A non-default limit catches a hard-coded limit of one.
          act(() => setup.mockInput.pressBackspace());
          await act(async () => setup.renderOnce());
          await act(async () => setup.mockInput.typeText("2"));
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Dependencies incomplete")
            )
          ).toBe(true);
          expect(setup.captureCharFrame()).toContain(
            "Up to 2 items per migration"
          );
          act(() => setup.mockInput.pressKey(include ? "i" : "f"));
          expect(
            await settle(
              setup.renderOnce,
              () =>
                setup.captureCharFrame().includes("2 migrated") &&
                !setup.captureCharFrame().includes("Stop run")
            )
          ).toBe(true);
          expect(start).toHaveBeenCalledWith(
            expect.objectContaining({
              request: expect.objectContaining({
                options: {
                  limit: 2,
                  force: !include,
                  withDependencies: include,
                },
              }),
              plan: expect.objectContaining({
                limit: 2,
                executionDefinitionIds: include
                  ? ["authors", "articles"]
                  : ["articles"],
              }),
            })
          );
          expect(
            (await runtime.refresh()).rows.map(
              (row) => row.status?.durable.migrated
            )
          ).toEqual(include ? [2, 2] : [0, 2]);
        } finally {
          act(() => root.unmount());
          setup.renderer.destroy();
        }
      }
    );
  }

  for (const method of ["keyboard", "mouse"]) {
    itWithOpenTui(
      `keeps source ID mode when selecting by ${method}, adding an identity, and reopening`,
      async () => {
        const runtime = await makeInProcessMigrationTuiRuntime({
          registry: makeLimitedRunConfig().registry,
          cwd: new URL("..", import.meta.url).pathname,
        });
        const start = vi.spyOn(runtime, "start");
        const setup = await createTestRenderer({ height: 30, width: 100 });
        const root = createRoot(setup.renderer);
        act(() => root.render(<MigrationTuiApp runtime={runtime} />));
        try {
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Status reloaded")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressKey("e"));
          await readySelectiveDialog(setup);
          if (method === "mouse") {
            for (const label of ["Source IDs", "Next items", "Source IDs"]) {
              const lines = setup.captureCharFrame().split("\n");
              const y = lines.findIndex((line) => line.includes(label));
              const x = lines[y]?.indexOf(label) ?? -1;
              expect(x).toBeGreaterThanOrEqual(0);
              await act(async () => setup.mockMouse.click(x + 2, y));
              expect(
                await settle(setup.renderOnce, () =>
                  setup.captureCharFrame().includes(`[ ${label} ]`)
                )
              ).toBe(true);
            }
          } else {
            act(() => setup.mockInput.pressTab({ shift: true }));
            await act(async () => setup.renderOnce());
            act(() => setup.mockInput.pressArrow("right"));
            await act(async () => setup.renderOnce());
            expect(setup.captureCharFrame()).toContain("[ Source IDs ]");
            act(() => setup.mockInput.pressArrow("left"));
            await act(async () => setup.renderOnce());
            expect(setup.captureCharFrame()).toContain("[ Next items ]");
            act(() => setup.mockInput.pressArrow("right"));
          }
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("[ Source IDs ]")
            )
          ).toBe(true);
          // Tab moves from the selection control into the active input.
          act(() => setup.mockInput.pressTab());
          await act(async () => setup.renderOnce());
          await act(async () => setup.mockInput.typeText("authors-1"));
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(setup.renderOnce, () => {
              const frame = setup.captureCharFrame();
              return (
                frame.includes("[ Source IDs ]") && frame.includes("1 selected")
              );
            }),
            setup.captureCharFrame()
          ).toBe(true);
          expect(start).not.toHaveBeenCalled();
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(
              setup.renderOnce,
              () =>
                setup.captureCharFrame().includes("1 migrated") &&
                !setup.captureCharFrame().includes("Stop run")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressKey("e"));
          await readySelectiveDialog(setup);
          expect(setup.captureCharFrame()).toContain("[ Source IDs ]");
          expect(setup.captureCharFrame()).toContain("1 selected");
        } finally {
          act(() => root.unmount());
          setup.renderer.destroy();
        }
      }
    );
  }

  for (const control of ["selection method", "Cancel", "Run"]) {
    itWithOpenTui(
      `handles Space on the focused ${control} control without toggling history`,
      async () => {
        const runtime = await makeInProcessMigrationTuiRuntime({
          registry: makeLimitedRunConfig().registry,
          cwd: new URL("..", import.meta.url).pathname,
        });
        const seeded = await runtime.start(
          await runtime.prepare(
            {
              kind: "definitions",
              definitionIds: [toMigrationDefinitionId("authors")],
            },
            "run",
            { limit: 1 }
          )
        );
        expect((await runtime.observeRun(seeded.runId)).outcome).toBe(
          "completed"
        );
        const start = vi.spyOn(runtime, "start");
        const setup = await createTestRenderer({ height: 30, width: 100 });
        const root = createRoot(setup.renderer);
        act(() => root.render(<MigrationTuiApp runtime={runtime} />));
        try {
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Status reloaded")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressKey("e"));
          await readySelectiveDialog(setup);
          act(() => setup.mockInput.pressTab({ shift: true }));
          await act(async () => setup.renderOnce());
          act(() => setup.mockInput.pressArrow("right"));
          expect(
            await settle(setup.renderOnce, () => {
              const frame = setup.captureCharFrame();
              return (
                frame.includes("[ Source IDs ]") && frame.includes("authors-1")
              );
            })
          ).toBe(true);

          if (control !== "selection method") {
            act(() => setup.mockInput.pressTab());
            await act(async () => setup.renderOnce());
            if (control === "Run") {
              await act(async () => setup.mockInput.typeText("authors-4"));
              act(() => setup.mockInput.pressEnter());
              expect(
                await settle(setup.renderOnce, () =>
                  setup.captureCharFrame().includes("1 selected")
                )
              ).toBe(true);
            }
            // Run is skipped when disabled, so an empty queue focuses Cancel.
            act(() => setup.mockInput.pressTab());
            await act(async () => setup.renderOnce());
          }

          act(() => setup.mockInput.pressKey(" "));
          await act(async () => setup.renderOnce());
          if (control === "selection method") {
            expect(setup.captureCharFrame()).toContain("[ Source IDs ]");
            expect(setup.captureCharFrame()).toContain("0 selected");
            expect(start).not.toHaveBeenCalled();
          } else if (control === "Cancel") {
            expect(
              await settle(
                setup.renderOnce,
                () => !setup.captureCharFrame().includes("Run selected entries")
              )
            ).toBe(true);
            expect(start).not.toHaveBeenCalled();
          } else {
            expect(
              await settle(setup.renderOnce, () =>
                setup.captureCharFrame().includes("2 migrated")
              )
            ).toBe(true);
            expect(start).toHaveBeenCalledTimes(1);
            expect(start).toHaveBeenCalledWith(
              expect.objectContaining({
                request: expect.objectContaining({
                  options: { sourceIdentities: ["authors-4"] },
                }),
              })
            );
          }
        } finally {
          act(() => root.unmount());
          setup.renderer.destroy();
        }
      }
    );
  }

  itWithOpenTui(
    "keeps the limit out of source ID requests and ordinary runs",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        registry: makeLimitedRunConfig().registry,
        cwd: new URL("..", import.meta.url).pathname,
      });
      const prepare = vi.spyOn(runtime, "prepare");
      const start = vi.spyOn(runtime, "start");
      const setup = await createTestRenderer({ height: 30, width: 100 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("e"));
        await chooseSourceIds(setup);
        await act(async () => setup.mockInput.typeText("authors-3"));
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("1 selected")
          )
        ).toBe(true);
        // Preserve the ID queue while changing selection methods, but send only the active method.
        await switchSelectionMethod(setup, "Next items");
        await switchSelectionMethod(setup, "Source IDs");
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(
            setup.renderOnce,
            () =>
              setup.captureCharFrame().includes("1 migrated") &&
              !setup.captureCharFrame().includes("Stop run")
          )
        ).toBe(true);
        expect(prepare).toHaveBeenLastCalledWith(
          { kind: "definitions", definitionIds: ["authors"] },
          "run",
          { sourceIdentities: ["authors-3"] }
        );
        act(() => setup.mockInput.pressKey("e"));
        await readySelectiveDialog(setup);
        await switchSelectionMethod(setup, "Next items");
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(
            setup.renderOnce,
            () =>
              setup.captureCharFrame().includes("2 migrated") &&
              !setup.captureCharFrame().includes("Stop run")
          )
        ).toBe(true);
        expect(prepare).toHaveBeenLastCalledWith(
          { kind: "definitions", definitionIds: ["authors"] },
          "run",
          { limit: 1 }
        );
        act(() => setup.mockInput.pressKey("r"));
        expect(
          await settle(
            setup.renderOnce,
            () =>
              setup.captureCharFrame().includes("4 migrated") &&
              !setup.captureCharFrame().includes("Stop run")
          ),
          setup.captureCharFrame()
        ).toBe(true);
        expect(start).toHaveBeenCalledTimes(3);
        expect(prepare).toHaveBeenLastCalledWith(
          { kind: "definitions", definitionIds: ["authors"] },
          "run",
          {}
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  itWithOpenTui(
    "requires a positive whole number before starting a limited run",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        registry: makeLimitedRunConfig().registry,
        cwd: new URL("..", import.meta.url).pathname,
      });
      const prepare = vi.spyOn(runtime, "prepare");
      const setup = await createTestRenderer({ height: 24, width: 72 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("e"));
        await readySelectiveDialog(setup);
        act(() => setup.mockInput.pressBackspace());
        await act(async () => setup.renderOnce());
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Enter a positive whole number.")
          )
        ).toBe(true);
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );

  for (const returnedLimit of [undefined, 2]) {
    itWithOpenTui(
      `refuses a limited run when the server returns limit ${returnedLimit}`,
      async () => {
        const base = await makeInProcessMigrationTuiRuntime({
          registry: makeLimitedRunConfig().registry,
          cwd: new URL("..", import.meta.url).pathname,
        });
        const runtime: MigrationTuiRuntime = {
          ...base,
          prepare: async (...args) => {
            const operation = await base.prepare(...args);
            const { limit: _limit, ...plan } = operation.plan;
            return {
              ...operation,
              plan: {
                ...plan,
                ...(returnedLimit === undefined
                  ? {}
                  : { limit: returnedLimit }),
              },
            };
          },
        };
        const start = vi.spyOn(runtime, "start");
        const setup = await createTestRenderer({ height: 30, width: 100 });
        const root = createRoot(setup.renderer);
        act(() => root.render(<MigrationTuiApp runtime={runtime} />));
        try {
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Status reloaded")
            )
          ).toBe(true);
          act(() => setup.mockInput.pressKey("e"));
          await readySelectiveDialog(setup);
          act(() => setup.mockInput.pressEnter());
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes("Server did not preserve")
            )
          ).toBe(true);
          expect(start).not.toHaveBeenCalled();
        } finally {
          act(() => root.unmount());
          setup.renderer.destroy();
        }
      }
    );
  }

  itWithOpenTui(
    "keeps selected IDs and history controls readable in a compact dialog",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        registry: makeLimitedRunConfig().registry,
        cwd: new URL("..", import.meta.url).pathname,
      });
      const seeded = await runtime.start(
        await runtime.prepare(
          {
            kind: "definitions",
            definitionIds: [toMigrationDefinitionId("authors")],
          },
          "run",
          { limit: 3 }
        )
      );
      expect((await runtime.observeRun(seeded.runId)).outcome).toBe(
        "completed"
      );
      // History is newest first, so its order need not match the source order.
      const historyIdentities = (
        await runtime.listSourceIdentityHistory(
          toMigrationDefinitionId("authors")
        )
      ).map((entry) => entry.sourceIdentity);
      expect([...historyIdentities].sort()).toEqual([
        "authors-1",
        "authors-2",
        "authors-3",
      ]);
      const start = vi.spyOn(runtime, "start");
      const setup = await createTestRenderer({ width: 72, height: 24 });
      const root = createRoot(setup.renderer);
      act(() => root.render(<MigrationTuiApp runtime={runtime} />));
      try {
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Status reloaded")
          )
        ).toBe(true);
        act(() => setup.mockInput.pressKey("e"));
        await chooseSourceIds(setup);
        for (const [index, identity] of historyIdentities.entries()) {
          if (index > 0) {
            act(() => setup.mockInput.pressArrow("down"));
            await act(async () => setup.renderOnce());
          }
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes(identity)
            ),
            setup.captureCharFrame()
          ).toBe(true);
          act(() => setup.mockInput.pressKey(" "));
          expect(
            await settle(setup.renderOnce, () =>
              setup.captureCharFrame().includes(`${index + 1} selected`)
            )
          ).toBe(true);
        }
        expect(setup.captureCharFrame()).toContain("Run 3 entries");
        expect(setup.captureCharFrame()).toContain("↑↓ history");
        expect(setup.captureCharFrame()).toContain(
          "tab focus · ←→ selection method"
        );
        act(() => setup.mockInput.pressEnter());
        expect(
          await settle(setup.renderOnce, () => start.mock.calls.length === 1)
        ).toBe(true);
        expect(start).toHaveBeenCalledWith(
          expect.objectContaining({
            request: expect.objectContaining({
              options: {
                sourceIdentities: historyIdentities,
              },
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
        await chooseSourceIds(setup);
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
        await chooseSourceIds(setup);
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
        await chooseSourceIds(setup);
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
        await chooseSourceIds(setup);
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
