import { describe, expect, it } from "vitest";
import {
  BROWSER_TERMINAL_INACTIVITY_MS,
  browserTerminalHeartbeatAction,
  SANDBOX_IDLE_TIMEOUT_MS,
  SANDBOX_MAX_SESSION_MS,
  sandboxHeartbeatDecision,
} from "./browser-terminal-policy";

describe("browser heartbeat policy", () => {
  it("skips hidden heartbeats without entering the paused state", () => {
    expect(
      browserTerminalHeartbeatAction({
        force: false,
        inactiveForMs: 10_000,
        isPaused: false,
        isVisible: false,
      })
    ).toBe("skip");
  });

  it("requires explicit renewal after the inactivity threshold", () => {
    expect(
      browserTerminalHeartbeatAction({
        force: false,
        inactiveForMs: BROWSER_TERMINAL_INACTIVITY_MS,
        isPaused: false,
        isVisible: true,
      })
    ).toBe("pause");
    expect(
      browserTerminalHeartbeatAction({
        force: false,
        inactiveForMs: 0,
        isPaused: true,
        isVisible: true,
      })
    ).toBe("skip");
    expect(
      browserTerminalHeartbeatAction({
        force: true,
        inactiveForMs: 0,
        isPaused: true,
        isVisible: true,
      })
    ).toBe("renew");
  });
});

describe("browser terminal timeout policy", () => {
  it("extends the deadline to the idle timeout from the heartbeat", () => {
    expect(
      sandboxHeartbeatDecision({
        expiresAtMs: 90_000,
        nowMs: 30_000,
        sessionStartedAtMs: 0,
      })
    ).toEqual({
      durationMs: SANDBOX_IDLE_TIMEOUT_MS - 60_000,
      kind: "extend",
    });
  });

  it("does not shorten a deadline that is already later", () => {
    expect(
      sandboxHeartbeatDecision({
        expiresAtMs: SANDBOX_IDLE_TIMEOUT_MS + 60_000,
        nowMs: 30_000,
        sessionStartedAtMs: 0,
      })
    ).toEqual({ kind: "unchanged" });
  });

  it("never extends a session past its absolute lifetime", () => {
    const nowMs = SANDBOX_MAX_SESSION_MS - 30_000;
    expect(
      sandboxHeartbeatDecision({
        expiresAtMs: SANDBOX_MAX_SESSION_MS - 60_000,
        nowMs,
        sessionStartedAtMs: 0,
      })
    ).toEqual({ durationMs: 60_000, kind: "extend" });
    expect(
      sandboxHeartbeatDecision({
        expiresAtMs: SANDBOX_MAX_SESSION_MS,
        nowMs: SANDBOX_MAX_SESSION_MS,
        sessionStartedAtMs: 0,
      })
    ).toEqual({ kind: "expired" });
  });
});
