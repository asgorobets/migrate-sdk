import { Effect, Schema } from "effect";
import {
  TUI_SANDBOX_PNPM_HOME,
  TUI_SANDBOX_PNPM_PATH,
  TUI_SANDBOX_WORKSPACE_CWD,
} from "../sandbox/tui-sandbox-runtime";
import type { SandboxTerminalSession } from "../terminal/sandbox-pty-protocol";
import { BrowserTerminalConfig } from "./browser-terminal-config";
import {
  type BrowserTerminalHeartbeatResult,
  type BrowserTerminalSandboxError,
  BrowserTerminalSandboxes,
  BrowserTerminalSandboxLease,
  type BrowserTerminalSandboxLeaseError,
} from "./browser-terminal-sandbox";

export class BrowserTerminalSessionExpiredError extends Schema.TaggedError<BrowserTerminalSessionExpiredError>()(
  "BrowserTerminalSessionExpiredError",
  {}
) {}

export const createBrowserTerminalSession = Effect.fn(
  "BrowserTerminal.createSession"
)(function* (): Effect.fn.Return<
  SandboxTerminalSession,
  | BrowserTerminalSessionExpiredError
  | BrowserTerminalSandboxError
  | BrowserTerminalSandboxLeaseError,
  BrowserTerminalConfig | BrowserTerminalSandboxes | BrowserTerminalSandboxLease
> {
  const config = yield* BrowserTerminalConfig;
  const sandboxes = yield* BrowserTerminalSandboxes;
  const lease = yield* BrowserTerminalSandboxLease;
  const sandbox = yield* sandboxes.getOrCreateRunning(config);

  const heartbeat = yield* lease.keepActive(config.name);
  if (heartbeat === "expired") {
    return yield* new BrowserTerminalSessionExpiredError();
  }

  const connection = yield* sandbox.openInteractive();
  return {
    connection,
    start: {
      args: [
        "--filter",
        "@migrate-sdk/tui",
        "dev",
        "--",
        "--server",
        config.migrationServerUrl.toString(),
      ],
      command: TUI_SANDBOX_PNPM_PATH,
      cwd: TUI_SANDBOX_WORKSPACE_CWD,
      env: [
        `PNPM_HOME=${TUI_SANDBOX_PNPM_HOME}`,
        "TERM=xterm-256color",
        "COLORTERM=truecolor",
      ],
    },
  };
});

export const keepBrowserTerminalSessionActive = Effect.fn(
  "BrowserTerminal.keepSessionActive"
)(function* (): Effect.fn.Return<
  BrowserTerminalHeartbeatResult,
  BrowserTerminalSandboxLeaseError,
  BrowserTerminalConfig | BrowserTerminalSandboxLease
> {
  const config = yield* BrowserTerminalConfig;
  const lease = yield* BrowserTerminalSandboxLease;
  return yield* lease.keepActive(config.name);
});
