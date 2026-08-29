import { APIError, Sandbox } from "@vercel/sandbox";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  SANDBOX_IDLE_TIMEOUT_MS,
  sandboxHeartbeatDecision,
} from "../terminal/browser-terminal-policy";
import type { SandboxTerminalSession } from "../terminal/sandbox-pty-protocol";
import type { BrowserTerminalSandboxConfig } from "./browser-terminal-config";

const BrowserTerminalSandboxOperation = Schema.Literals([
  "extend",
  "get",
  "get-or-create",
  "open-interactive",
]);

export class BrowserTerminalSandboxError extends Schema.TaggedError<BrowserTerminalSandboxError>()(
  "BrowserTerminalSandboxError",
  {
    cause: Schema.Defect(),
    operation: BrowserTerminalSandboxOperation,
  }
) {}

export class BrowserTerminalSandboxLeaseError extends Schema.TaggedError<BrowserTerminalSandboxLeaseError>()(
  "BrowserTerminalSandboxLeaseError",
  { cause: Schema.Defect() }
) {}

export type BrowserTerminalHeartbeatResult = "active" | "expired";

export interface BrowserTerminalSandboxHandle {
  readonly expiresAt: Date | undefined;
  readonly extendTimeout: (
    durationMs: number
  ) => Effect.Effect<void, BrowserTerminalSandboxError>;
  readonly openInteractive: () => Effect.Effect<
    SandboxTerminalSession["connection"],
    BrowserTerminalSandboxError
  >;
  readonly sessionStartedAt: Date;
  readonly status: string;
}

function sandboxError(
  operation: typeof BrowserTerminalSandboxOperation.Type,
  cause: unknown
): BrowserTerminalSandboxError {
  return new BrowserTerminalSandboxError({ cause, operation });
}

function toBrowserTerminalSandboxHandle(
  sandbox: Sandbox
): BrowserTerminalSandboxHandle {
  const session = sandbox.currentSession();
  return {
    expiresAt: sandbox.expiresAt,
    extendTimeout: (durationMs) =>
      Effect.tryPromise({
        catch: (cause) => sandboxError("extend", cause),
        try: () => sandbox.extendTimeout(durationMs),
      }),
    openInteractive: () =>
      Effect.tryPromise({
        catch: (cause) => sandboxError("open-interactive", cause),
        try: () => sandbox.openInteractive(),
      }),
    sessionStartedAt: session.startedAt ?? session.createdAt,
    status: sandbox.status,
  };
}

export class BrowserTerminalSandboxes extends Context.Service<
  BrowserTerminalSandboxes,
  {
    readonly get: (
      name: string
    ) => Effect.Effect<
      BrowserTerminalSandboxHandle | undefined,
      BrowserTerminalSandboxError
    >;
    readonly getOrCreateRunning: (
      config: BrowserTerminalSandboxConfig
    ) => Effect.Effect<
      BrowserTerminalSandboxHandle,
      BrowserTerminalSandboxError
    >;
  }
>()("@migrate-sdk/examples/workflow-sdk/BrowserTerminalSandboxes") {
  static readonly layer = Layer.succeed(BrowserTerminalSandboxes, {
    get: Effect.fn("BrowserTerminalSandboxes.get")((name: string) =>
      Effect.tryPromise({
        catch: (cause) => sandboxError("get", cause),
        try: async () => {
          try {
            return toBrowserTerminalSandboxHandle(await Sandbox.get({ name }));
          } catch (cause) {
            if (cause instanceof APIError && cause.response.status === 404) {
              return;
            }
            throw cause;
          }
        },
      })
    ),
    getOrCreateRunning: Effect.fn(
      "BrowserTerminalSandboxes.getOrCreateRunning"
    )((config: BrowserTerminalSandboxConfig) =>
      Effect.tryPromise({
        catch: (cause) => sandboxError("get-or-create", cause),
        try: () =>
          Sandbox.getOrCreate({
            name: config.name,
            networkPolicy: {
              allow: {
                [config.migrationServerUrl.hostname]: [
                  {
                    match: {
                      method: ["POST"],
                      path: { exact: config.migrationServerUrl.pathname },
                    },
                    transform: [
                      {
                        headers: {
                          authorization: `Bearer ${config.migrateServerToken}`,
                        },
                      },
                    ],
                  },
                ],
              },
            },
            persistent: false,
            resources: { vcpus: 1 },
            resume: true,
            source: { snapshotId: config.snapshotId, type: "snapshot" },
            tags: { purpose: "migrate-tui-demo" },
            timeout: SANDBOX_IDLE_TIMEOUT_MS,
          }).then(toBrowserTerminalSandboxHandle),
      })
    ),
  });
}

function leaseError(cause: unknown): BrowserTerminalSandboxLeaseError {
  return cause instanceof BrowserTerminalSandboxLeaseError
    ? cause
    : new BrowserTerminalSandboxLeaseError({ cause });
}

export class BrowserTerminalSandboxLease extends Context.Service<
  BrowserTerminalSandboxLease,
  {
    readonly keepActive: (
      name: string
    ) => Effect.Effect<
      BrowserTerminalHeartbeatResult,
      BrowserTerminalSandboxLeaseError
    >;
  }
>()("@migrate-sdk/examples/workflow-sdk/BrowserTerminalSandboxLease") {
  static readonly layer = Layer.effect(
    BrowserTerminalSandboxLease,
    Effect.gen(function* () {
      const sandboxes = yield* BrowserTerminalSandboxes;
      const sql = yield* SqlClient.SqlClient;

      const keepActive = Effect.fn("BrowserTerminalSandboxLease.keepActive")(
        (name: string) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                const [lock] = yield* sql<{ readonly acquired: boolean }>`
                  SELECT pg_try_advisory_xact_lock(hashtext(${name})) AS acquired
                `;
                if (!lock?.acquired) {
                  return "active" as const;
                }

                const sandbox = yield* sandboxes.get(name);
                if (!sandbox || sandbox.status !== "running") {
                  return "expired" as const;
                }

                const nowMs = yield* Clock.currentTimeMillis;
                const decision = sandboxHeartbeatDecision({
                  expiresAtMs: sandbox.expiresAt?.getTime() ?? nowMs,
                  nowMs,
                  sessionStartedAtMs: sandbox.sessionStartedAt.getTime(),
                });

                if (decision.kind === "expired") {
                  return "expired" as const;
                }
                if (decision.kind === "extend") {
                  yield* sandbox.extendTimeout(decision.durationMs);
                }
                return "active" as const;
              })
            )
            .pipe(Effect.mapError(leaseError))
      );

      return { keepActive };
    })
  );
}
