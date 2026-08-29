export const BROWSER_TERMINAL_HEARTBEAT_INTERVAL_MS = 30 * 1000;
export const BROWSER_TERMINAL_INACTIVITY_MS = 3 * 60 * 1000;
export const SANDBOX_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
export const SANDBOX_MAX_SESSION_MS = 30 * 60 * 1000;
const SANDBOX_MIN_TIMEOUT_EXTENSION_MS = 1000;

export type BrowserTerminalHeartbeatAction = "pause" | "renew" | "skip";

export const browserTerminalHeartbeatAction = (input: {
  readonly force: boolean;
  readonly inactiveForMs: number;
  readonly isPaused: boolean;
  readonly isVisible: boolean;
}): BrowserTerminalHeartbeatAction => {
  if (input.force) {
    return "renew";
  }
  if (input.isPaused || !input.isVisible) {
    return "skip";
  }
  return input.inactiveForMs >= BROWSER_TERMINAL_INACTIVITY_MS
    ? "pause"
    : "renew";
};

export type SandboxHeartbeatDecision =
  | { readonly kind: "expired" }
  | { readonly durationMs: number; readonly kind: "extend" }
  | { readonly kind: "unchanged" };

export const sandboxHeartbeatDecision = (input: {
  readonly expiresAtMs: number;
  readonly nowMs: number;
  readonly sessionStartedAtMs: number;
}): SandboxHeartbeatDecision => {
  const maximumExpiresAtMs = input.sessionStartedAtMs + SANDBOX_MAX_SESSION_MS;
  if (input.nowMs >= maximumExpiresAtMs) {
    return { kind: "expired" };
  }

  const targetExpiresAtMs = Math.min(
    input.nowMs + SANDBOX_IDLE_TIMEOUT_MS,
    maximumExpiresAtMs
  );
  const durationMs = targetExpiresAtMs - input.expiresAtMs;
  return durationMs >= SANDBOX_MIN_TIMEOUT_EXTENSION_MS
    ? { durationMs, kind: "extend" }
    : { kind: "unchanged" };
};
