import { describe, expect, it, vi } from "vitest";
import { initializeMigrationTuiRenderSession } from "./render-session.tsx";

describe("Migration TUI render session", () => {
  it("destroys the renderer when terminal setup fails", () => {
    const setupError = new Error("terminal title failed");
    const destroy = vi.fn();
    const off = vi.fn();
    const on = vi.fn();
    const mount = vi.fn();

    expect(() =>
      initializeMigrationTuiRenderSession({
        mount,
        onControlC: vi.fn(),
        renderer: {
          destroy,
          keyInput: { off, on },
          setTerminalTitle: vi.fn(() => {
            throw setupError;
          }),
        },
      })
    ).toThrow(setupError);

    expect(on).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledOnce();
    expect(mount).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("destroys the renderer when mounting fails", () => {
    const mountError = new Error("mount failed");
    const destroy = vi.fn();
    const off = vi.fn();

    expect(() =>
      initializeMigrationTuiRenderSession({
        mount: () => {
          throw mountError;
        },
        onControlC: vi.fn(),
        renderer: {
          destroy,
          keyInput: { off, on: vi.fn() },
          setTerminalTitle: vi.fn(),
        },
      })
    ).toThrow(mountError);

    expect(off).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
