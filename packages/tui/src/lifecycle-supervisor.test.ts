import { MigrateDashboardResumeToken } from "migrate-sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type MigrationTuiRenderSessionInput,
  makeMigrationTuiLifecycleSupervisor,
} from "./lifecycle-supervisor.ts";
import type { MigrationTuiSnapshot } from "./runtime.ts";

const waitFor = async (predicate: () => boolean): Promise<void> => {
  await vi.waitFor(() => expect(predicate()).toBe(true));
};

describe("Migration TUI lifecycle supervisor", () => {
  it("destroys a failed renderer and recovers once from durable state", async () => {
    const rows: MigrationTuiSnapshot["rows"] = [];
    const inputs: MigrationTuiRenderSessionInput[] = [];
    const destroys: ReturnType<typeof vi.fn>[] = [];
    const exitCodes: number[] = [];
    const errors: string[] = [];
    const snapshot: MigrationTuiSnapshot = {
      activeRuns: [],
      resumeToken: MigrateDashboardResumeToken.make("test:snapshot"),
      rows,
      scannedSource: false,
    };
    const supervisor = makeMigrationTuiLifecycleSupervisor({
      createSession: (input) => {
        const destroy = vi.fn();
        inputs.push(input);
        destroys.push(destroy);
        return Promise.resolve({ destroy });
      },
      forceExit: vi.fn(),
      runtime: {
        detachForExit: () => Promise.resolve({ kind: "idle" }),
        refresh: vi.fn(() => Promise.resolve(snapshot)),
      },
      setExitCode: (code) => exitCodes.push(code),
      signalSource: {
        off: vi.fn(),
        on: vi.fn(),
      },
      writeError: (message) => errors.push(message),
    });

    await supervisor.start();
    inputs[0]?.onRenderError(new Error("host text invariant"));
    await waitFor(() => inputs.length === 2);

    expect(destroys[0]).toHaveBeenCalledOnce();
    expect(inputs[1]?.initialRows).toBe(rows);
    expect(inputs[1]?.recoveryNotice).toContain(
      "UI recovered from a renderer error"
    );
    expect(inputs[1]?.lifecycle).toBe(inputs[0]?.lifecycle);
    expect(errors.join("\n")).toContain("host text invariant");

    inputs[1]?.onRenderError(new Error("renderer failed again"));
    await supervisor.wait();

    expect(destroys[1]).toHaveBeenCalledOnce();
    expect(exitCodes.at(-1)).toBe(1);
    expect(errors.join("\n")).toContain("renderer failed again");
  });

  it("forces terminal restoration on a second Ctrl-C", async () => {
    const cancellation = Promise.withResolvers<{
      readonly kind: "detached";
      readonly message: string;
    }>();
    const detachForExit = vi.fn(() => cancellation.promise);
    const destroy = vi.fn();
    const forceExit = vi.fn();
    let sessionInput: MigrationTuiRenderSessionInput | undefined;
    const supervisor = makeMigrationTuiLifecycleSupervisor({
      createSession: (input) => {
        sessionInput = input;
        return Promise.resolve({ destroy });
      },
      forceExit,
      runtime: {
        detachForExit,
        refresh: () =>
          Promise.resolve({
            activeRuns: [],
            resumeToken: MigrateDashboardResumeToken.make("test:snapshot"),
            rows: [],
            scannedSource: false as const,
          }),
      },
      setExitCode: vi.fn(),
      signalSource: {
        off: vi.fn(),
        on: vi.fn(),
      },
      writeError: vi.fn(),
    });

    await supervisor.start();
    sessionInput?.onControlC();
    await waitFor(() => detachForExit.mock.calls.length === 1);

    expect(destroy).not.toHaveBeenCalled();

    sessionInput?.onControlC();
    await supervisor.wait();

    expect(destroy).toHaveBeenCalledOnce();
    expect(forceExit).toHaveBeenCalledWith(130);

    cancellation.resolve({
      kind: "detached",
      message: "Detachment completed",
    });
  });

  it("forces terminal restoration when graceful cancellation times out", async () => {
    const destroy = vi.fn();
    const forceExit = vi.fn();
    let sessionInput: MigrationTuiRenderSessionInput | undefined;
    const supervisor = makeMigrationTuiLifecycleSupervisor({
      createSession: (input) => {
        sessionInput = input;
        return Promise.resolve({ destroy });
      },
      forceExit,
      forceExitTimeoutMs: 1,
      runtime: {
        detachForExit: () => new Promise(() => undefined),
        refresh: () =>
          Promise.resolve({
            activeRuns: [],
            resumeToken: MigrateDashboardResumeToken.make("test:snapshot"),
            rows: [],
            scannedSource: false as const,
          }),
      },
      setExitCode: vi.fn(),
      signalSource: {
        off: vi.fn(),
        on: vi.fn(),
      },
      writeError: vi.fn(),
    });

    await supervisor.start();
    sessionInput?.onControlC();
    await supervisor.wait();

    expect(destroy).toHaveBeenCalledOnce();
    expect(forceExit).toHaveBeenCalledWith(130);
  });
});
