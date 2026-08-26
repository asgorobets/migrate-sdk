import { createTestRenderer } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";
import {
  type MigrationRunId,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import {
  MigrateExecutionId,
  type MigrateExecutionReference,
} from "migrate-sdk/protocol";
import { act } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MigrationTuiApp as MigrationTuiAppView } from "./app.tsx";
import type { MigrationTuiExecutionResult } from "./execution.ts";
import { MigrationTuiRenderErrorBoundary } from "./render-session.tsx";
import {
  type ConfiguredMigrationExecution,
  loadConfiguredMigrationHost,
  type MigrationTuiExecuteOptions,
  type MigrationTuiMessage,
  type MigrationTuiRuntime,
  type MigrationTuiSourceIdentityHistoryEntry,
} from "./runtime.ts";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
const processConcurrencyValuePattern = /│ 3\s+│/;
const rollbackConcurrencyValuePattern = /│ 5\s+│/;
const sourceInventoryScanConcurrencyValuePattern = /│ 2\s+│/;
const liveProgressNotRunPattern = /live-progress\s+NOT RUN/;
const liveProgressPrerequisiteSucceededPattern =
  /live-progress-prerequisite\s+SUCCEEDED/;
const messageRunId = toMigrationRunId("run-messages");

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
  ...args: Parameters<typeof loadConfiguredMigrationHost>
): Promise<MigrationTuiRuntime> => {
  const server = await Effect.runPromise(
    Effect.scoped(loadConfiguredMigrationHost(...args))
  );
  let executionSequence = 0;
  let activeObservation:
    | { readonly controller: AbortController; readonly runId: MigrationRunId }
    | undefined;
  interface InProcessExecution {
    readonly execution: ConfiguredMigrationExecution;
    observer?: MigrationTuiExecuteOptions | undefined;
    readonly result: Promise<MigrationTuiExecutionResult>;
  }
  const executions = new Map<MigrationRunId, InProcessExecution>();
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
    breakLock: (lock) => Effect.runPromise(server.breakLock(lock)),
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
    normalizeSourceIdentity: (definitionId, sourceIdentity) =>
      Effect.runPromise(
        server.normalizeSourceIdentity(definitionId, sourceIdentity)
      ),
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
        });
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
      Effect.runPromise(
        server.prepare(...input)
      )) as unknown as MigrationTuiRuntime["prepare"],
    refresh: () => Effect.runPromise(server.refresh),
    scanSource: (target, options) =>
      Effect.runPromise(server.scanSource(target, options)),
    start: async (operation) => {
      const started = Promise.withResolvers<MigrateExecutionReference>();
      let record: InProcessExecution | undefined;
      const execution = await Effect.runPromise(
        server.startExecution(
          operation as unknown as Parameters<typeof server.startExecution>[0],
          {
            onObservationWarning: (message) =>
              record?.observer?.onObservationWarning?.(message),
            onProgress: (progress) => record?.observer?.onProgress?.(progress),
            onProgressError: (cause) =>
              record?.observer?.onProgressError?.(cause),
            onStateChange: (state) => {
              record?.observer?.onStateChange?.(state);
              if (state.kind === "running" || state.kind === "observing") {
                if (record !== undefined) {
                  executions.set(state.runId, record);
                }
                started.resolve({
                  ...(state.kind === "observing"
                    ? {
                        adapter: state.adapter,
                        providerExecutionId: state.executionId,
                      }
                    : { adapter: state.adapter }),
                  executionId: MigrateExecutionId.make(
                    `test-execution-${executionSequence++}`
                  ),
                  lifecycle:
                    state.kind === "observing" ? "detached" : "attached",
                  runId: state.runId,
                });
              }
            },
          }
        )
      );
      const completion = Promise.withResolvers<MigrationTuiExecutionResult>();
      record = { execution, result: completion.promise };
      Effect.runPromise(execution.result).then(
        completion.resolve,
        completion.reject
      );
      completion.promise
        .catch(() => undefined)
        .finally(() => {
          for (const [runId, candidate] of executions) {
            if (candidate === record) {
              executions.delete(runId);
            }
          }
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
        case "detached":
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
        configPath: "examples/migrate.config.ts",
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
    "updates durable item counts while an inline run is still active",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/live-progress.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
        progressFallbackIntervalMs: 10,
        terminalPollIntervalMs: 10,
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

        act(() => setup.mockInput.pressKey("r"));

        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            const hasIntermediateCount = [1, 2, 3].some((count) =>
              frame.includes(`${count} migrated`)
            );

            return hasIntermediateCount;
          })
        ).toBe(true);
        expect(
          await settle(
            setup.renderOnce,
            () => {
              const frame = setup.captureCharFrame();
              return (
                frame.includes("4 migrated") && frame.includes("succeeded")
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
    "keeps keyboard navigation available while a migration is running",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/dependent-live-progress.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
        progressFallbackIntervalMs: 10,
        terminalPollIntervalMs: 10,
      });
      const prerequisite = await runtime.prepare(
        {
          definitionId: toMigrationDefinitionId("live-progress-prerequisite"),
          kind: "migration",
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
              liveProgressPrerequisiteSucceededPattern.test(frame) &&
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
        configPath: "examples/migrate.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const messages: readonly MigrationTuiMessage[] = Array.from(
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
    "expands and scrolls long messages while keeping controls visible",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/migrate.config.ts",
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
        configPath: "examples/migrate.config.ts",
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
        configPath: "examples/source-status.config.ts",
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
    "reloads status after a source inventory scan without crashing the renderer",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/source-status.config.ts",
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
        configPath: "examples/source-status.config.ts",
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
        configPath: "examples/locked.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const runId = toMigrationRunId("run-stuck");
      const observeRun = vi.fn(() =>
        Promise.resolve({
          message: `Run ${runId} succeeded`,
          outcome: "completed" as const,
          runId,
        })
      );
      const stopRun = vi.fn(() =>
        Promise.resolve({
          kind: "requested" as const,
          message: `Stopping run ${runId}`,
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

        act(() => setup.mockInput.pressKey("x"));
        expect(
          await settle(setup.renderOnce, () => stopRun.mock.calls.length > 0)
        ).toBe(true);
        expect(stopRun).toHaveBeenCalledWith(runId);

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
        configPath: "examples/migrate.config.ts",
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
      const observeRun = vi.fn(() => observation.promise);
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

  itWithOpenTui("replaces active-run actions after a source scan", async () => {
    const baseRuntime = await makeInProcessMigrationTuiRuntime({
      configPath: "examples/locked.config.ts",
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
      expect(setup.captureCharFrame()).not.toContain("v View run");
    } finally {
      act(() => root.unmount());
      setup.renderer.destroy();
    }
  });

  itWithOpenTui(
    "reloads durable status after a reconnectable run fails",
    async () => {
      const baseRuntime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/locked.config.ts",
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
      const refresh = vi
        .fn<MigrationTuiRuntime["refresh"]>()
        .mockResolvedValueOnce({ ...durable, activeRuns: [activeRun] })
        .mockResolvedValueOnce({ ...durable, activeRuns: [] });
      const runtime: MigrationTuiRuntime = {
        ...baseRuntime,
        refresh,
        observeRun: vi.fn(() =>
          Promise.reject(new Error(`Run ${runId} failed`))
        ),
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

        act(() => setup.mockInput.pressKey("v"));

        expect(
          await settle(
            setup.renderOnce,
            () =>
              refresh.mock.calls.length === 2 &&
              setup.captureCharFrame().includes(`Run ${runId} failed`)
          )
        ).toBe(true);
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
        configPath: "examples/locked.config.ts",
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
        configPath: "examples/migrate.config.ts",
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
        configPath: "examples/migrate.config.ts",
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
        configPath: "examples/migrate.config.ts",
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
        configPath: "examples/dependency-preflight.config.ts",
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
              frame.includes("Required dependencies not ready") &&
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
        configPath: "examples/dependency-preflight.config.ts",
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
            setup.captureCharFrame().includes("Required dependencies not ready")
          )
        ).toBe(true);

        act(() => setup.resize(72, 34));
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
        configPath: "examples/migrate.config.ts",
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
            setup.captureCharFrame().includes("articles  FAILED")
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
        configPath: "examples/migrate.config.ts",
        cwd: new URL("..", import.meta.url).pathname,
      });
      const authorsId = toMigrationDefinitionId("authors");
      const articlesId = toMigrationDefinitionId("articles");
      const authorsHistory =
        Promise.withResolvers<
          readonly MigrationTuiSourceIdentityHistoryEntry[]
        >();
      const articlesHistory =
        Promise.withResolvers<
          readonly MigrationTuiSourceIdentityHistoryEntry[]
        >();
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
        expect(
          selectedFrame.includes("│ articles  FAILED") ||
            selectedFrame.includes("│ articles  SUCCEEDED")
        ).toBe(true);
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
    "renders transitive rollback dependents as a numbered hierarchy",
    async () => {
      const runtime = await makeInProcessMigrationTuiRuntime({
        configPath: "examples/transitive-dependency.config.ts",
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

        act(() => setup.mockInput.pressKey("b"));
        expect(
          await settle(setup.renderOnce, () =>
            setup.captureCharFrame().includes("Confirm rollback")
          )
        ).toBe(true);

        const frame = setup.captureCharFrame();
        expect(frame).toContain("Step numbers show rollback execution order");
        expect(frame).toContain("Affected migration hierarchy");
        expect(frame).toContain("authors step 3");
        expect(frame).toContain("└─ ○ articles step 2");
        expect(frame).toContain("   └─ ○ pages step 1");
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
        expect(
          await settle(setup.renderOnce, () => {
            const frame = setup.captureCharFrame();
            return (
              frame.includes("Confirm rollback") &&
              frame.includes("↑↓ scroll · y rollback · n/esc cancel")
            );
          })
        ).toBe(true);
        expect(setup.captureCharFrame()).not.toContain("migration-02 step 17");

        for (let index = 0; index < 20; index += 1) {
          act(() => {
            setup.mockInput.pressArrow("down");
          });
          await act(async () => setup.renderOnce());
        }
        expect(setup.captureCharFrame()).toContain("migration-02 step 17");
        expect(setup.captureCharFrame()).toContain(
          "↑↓ scroll · y rollback · n/esc cancel"
        );
      } finally {
        act(() => root.unmount());
        setup.renderer.destroy();
      }
    }
  );
});
