import { createHash } from "node:crypto";
import { Config, Context, Effect, Layer, Schema } from "effect";
import {
  SANDBOX_IDLE_TIMEOUT_MS,
  SANDBOX_MAX_SESSION_MS,
} from "../terminal/browser-terminal-policy";
import { MigrateServerAccess } from "./migrate-server-access";

export interface BrowserTerminalSandboxConfig {
  readonly migrateServerToken: string;
  readonly migrationServerUrl: URL;
  readonly name: string;
  readonly snapshotId: string;
}

export class BrowserTerminalConfigError extends Schema.TaggedError<BrowserTerminalConfigError>()(
  "BrowserTerminalConfigError",
  { cause: Schema.Defect() }
) {}

export function parseBrowserTerminalMigrationServerUrl(
  value: string | undefined
): URL {
  const candidate = value?.trim();
  if (!candidate) {
    throw new Error(
      "MIGRATE_SERVER_PUBLIC_URL is required to start the browser TUI"
    );
  }

  const url = new URL(candidate);
  if (url.protocol !== "https:") {
    throw new Error("MIGRATE_SERVER_PUBLIC_URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "MIGRATE_SERVER_PUBLIC_URL cannot contain credentials, a query, or a fragment"
    );
  }
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return url;
}

function sharedSandboxNameFor(
  migrationServerUrl: URL,
  snapshotId: string,
  migrateServerToken: string
): string {
  const deploymentId = createHash("sha256")
    .update(
      `${migrationServerUrl.href}:${snapshotId}:${migrateServerToken}:${SANDBOX_IDLE_TIMEOUT_MS}:${SANDBOX_MAX_SESSION_MS}`
    )
    .digest("hex")
    .slice(0, 12);
  return `migrate-tui-demo-${deploymentId}`;
}

const makeBrowserTerminalConfig = Effect.gen(function* () {
  const { token: migrateServerToken } = yield* MigrateServerAccess;
  const snapshotId = yield* Config.string(
    "MIGRATE_TUI_SANDBOX_SNAPSHOT_ID"
  ).pipe(Config.map((value) => value.trim()));
  const migrationServerUrlValue = yield* Config.string(
    "MIGRATE_SERVER_PUBLIC_URL"
  );

  if (migrateServerToken.length === 0) {
    return yield* new BrowserTerminalConfigError({
      cause: new Error("MIGRATE_SERVER_TOKEN is required"),
    });
  }
  if (snapshotId.length === 0) {
    return yield* new BrowserTerminalConfigError({
      cause: new Error("MIGRATE_TUI_SANDBOX_SNAPSHOT_ID is required"),
    });
  }

  const migrationServerUrl = yield* Effect.try({
    catch: (cause) => new BrowserTerminalConfigError({ cause }),
    try: () => parseBrowserTerminalMigrationServerUrl(migrationServerUrlValue),
  });
  return {
    migrateServerToken,
    migrationServerUrl,
    name: sharedSandboxNameFor(
      migrationServerUrl,
      snapshotId,
      migrateServerToken
    ),
    snapshotId,
  } satisfies BrowserTerminalSandboxConfig;
}).pipe(
  Effect.mapError((cause) =>
    cause instanceof BrowserTerminalConfigError
      ? cause
      : new BrowserTerminalConfigError({ cause })
  )
);

export class BrowserTerminalConfig extends Context.Service<
  BrowserTerminalConfig,
  BrowserTerminalSandboxConfig
>()("@migrate-sdk/examples/workflow-sdk/BrowserTerminalConfig") {
  static readonly layer = Layer.effect(
    BrowserTerminalConfig,
    makeBrowserTerminalConfig
  );
}
