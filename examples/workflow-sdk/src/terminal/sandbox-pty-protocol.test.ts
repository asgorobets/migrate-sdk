import { describe, expect, it } from "vitest";
import {
  isSandboxTerminalSession,
  makeSandboxPtyResizeMessage,
  makeSandboxPtyStartMessage,
  parseSandboxPtyExitMessage,
  type SandboxTerminalSession,
} from "./sandbox-pty-protocol";

const session: SandboxTerminalSession = {
  connection: {
    token: "pty-token",
    url: "wss://sandbox.example/pty",
  },
  start: {
    args: ["--filter", "@migrate-sdk/tui", "dev"],
    command: "pnpm",
    cwd: "/vercel/sandbox",
    env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
  },
};

describe("Sandbox PTY protocol", () => {
  it("validates the session boundary returned by the server", () => {
    expect(isSandboxTerminalSession(session)).toBe(true);
    expect(
      isSandboxTerminalSession({
        ...session,
        connection: { url: session.connection.url },
      })
    ).toBe(false);
  });

  it("creates the controller start and resize frames", () => {
    expect(
      JSON.parse(makeSandboxPtyStartMessage(session, { cols: 120, rows: 36 }))
    ).toEqual({
      args: ["--filter", "@migrate-sdk/tui", "dev"],
      cols: 120,
      command: "pnpm",
      cwd: "/vercel/sandbox",
      env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
      rows: 36,
      type: "start",
    });
    expect(
      JSON.parse(makeSandboxPtyResizeMessage({ cols: 90, rows: 24 }))
    ).toEqual({ cols: 90, rows: 24, type: "resize" });
  });

  it("accepts only exit control messages", () => {
    expect(parseSandboxPtyExitMessage('{"type":"exit","code":0}')).toEqual({
      code: 0,
      type: "exit",
    });
    expect(parseSandboxPtyExitMessage('{"type":"ready"}')).toBeUndefined();
    expect(parseSandboxPtyExitMessage("not json")).toBeUndefined();
  });
});
