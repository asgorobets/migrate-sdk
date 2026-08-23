import { describe, expect, it, vi } from "vitest";
import {
  type MigrationTuiExitSignal,
  makeMigrationTuiShutdownController,
  registerMigrationTuiSignalHandlers,
} from "./shutdown-controller.ts";

describe("Migration TUI shutdown controller", () => {
  it("routes supported process signals through the safe exit path", () => {
    const listeners = new Map<MigrationTuiExitSignal, () => void>();
    const onSignal = vi.fn();
    const off = vi.fn();
    const unregister = registerMigrationTuiSignalHandlers({
      onSignal,
      source: {
        off,
        on: (signal, listener) => {
          listeners.set(signal, listener);
        },
      },
    });

    listeners.get("SIGHUP")?.();
    listeners.get("SIGINT")?.();
    listeners.get("SIGTERM")?.();

    expect(onSignal.mock.calls).toEqual([
      ["SIGHUP", 129],
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ]);

    unregister();
    expect(off).toHaveBeenCalledTimes(3);
  });

  it("destroys an idle TUI exactly once", async () => {
    const destroy = vi.fn();
    const cancelActiveExecution = vi.fn(() =>
      Promise.resolve({ kind: "idle" as const })
    );
    const controller = makeMigrationTuiShutdownController({
      cancelActiveExecution,
      destroy,
    });

    await Promise.all([controller.requestExit(), controller.requestExit()]);
    controller.executionSettled();

    expect(cancelActiveExecution).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("waits for active execution to settle before destroying the TUI", async () => {
    const destroy = vi.fn();
    const controller = makeMigrationTuiShutdownController({
      cancelActiveExecution: () =>
        Promise.resolve({
          kind: "requested" as const,
          message: "Cancelling; waiting for active work to finish…",
        }),
      destroy,
    });

    const cancellation = await controller.requestExit();

    expect(cancellation.kind).toBe("requested");
    expect(controller.isExitRequested()).toBe(true);
    expect(destroy).not.toHaveBeenCalled();

    expect(controller.executionSettled()).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("allows shutdown to be retried when cancellation fails", async () => {
    const destroy = vi.fn();
    const cancelActiveExecution = vi
      .fn<() => Promise<{ readonly kind: "idle" }>>()
      .mockRejectedValueOnce(new Error("cancel failed"))
      .mockResolvedValueOnce({ kind: "idle" });
    const controller = makeMigrationTuiShutdownController({
      cancelActiveExecution,
      destroy,
    });

    await expect(controller.requestExit()).rejects.toThrow("cancel failed");
    expect(controller.isExitRequested()).toBe(false);

    await controller.requestExit();

    expect(cancelActiveExecution).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
