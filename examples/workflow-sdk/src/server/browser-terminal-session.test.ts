import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { BrowserTerminalConfig } from "./browser-terminal-config";
import {
  BrowserTerminalSandboxes,
  BrowserTerminalSandboxLease,
} from "./browser-terminal-sandbox";
import {
  createBrowserTerminalSession,
  keepBrowserTerminalSessionActive,
} from "./browser-terminal-session";

const config = {
  migrateServerToken: "migrate-secret",
  migrationServerUrl: new URL("https://workflow.example.com/api/migrate"),
  name: "shared-sandbox",
  snapshotId: "snap_example",
};

const testLayer = (events: string[]) =>
  Layer.mergeAll(
    Layer.succeed(BrowserTerminalConfig, config),
    Layer.succeed(BrowserTerminalSandboxes, {
      get: () => Effect.succeed(undefined),
      getOrCreateRunning: () =>
        Effect.sync(() => {
          events.push("get-or-create-running");
          return {
            expiresAt: new Date(Date.now() + 120_000),
            extendTimeout: () => Effect.void,
            openInteractive: () =>
              Effect.sync(() => {
                events.push("open-interactive");
                return {
                  token: "pty-token",
                  url: "wss://sandbox.example/pty",
                };
              }),
            sessionStartedAt: new Date(),
            status: "running",
          };
        }),
    }),
    Layer.succeed(BrowserTerminalSandboxLease, {
      keepActive: (name) =>
        Effect.sync(() => {
          events.push(`keep-active:${name}`);
          return "active";
        }),
    })
  );

describe("browser terminal session", () => {
  it("resumes and renews the sandbox before opening the PTY", async () => {
    const events: string[] = [];

    const session = await Effect.runPromise(
      createBrowserTerminalSession().pipe(Effect.provide(testLayer(events)))
    );

    expect(events).toEqual([
      "get-or-create-running",
      "keep-active:shared-sandbox",
      "open-interactive",
    ]);
    expect(session.connection.token).toBe("pty-token");
    expect(session.start.command).toBe("/vercel/sandbox/.pnpm/pnpm");
    expect(session.start.cwd).toBe("/vercel/sandbox");
    expect(session.start.env).toContain("PNPM_HOME=/vercel/sandbox/.pnpm");
  });

  it("uses the same lease for browser heartbeats", async () => {
    const events: string[] = [];

    await expect(
      Effect.runPromise(
        keepBrowserTerminalSessionActive().pipe(
          Effect.provide(testLayer(events))
        )
      )
    ).resolves.toBe("active");
    expect(events).toEqual(["keep-active:shared-sandbox"]);
  });
});
