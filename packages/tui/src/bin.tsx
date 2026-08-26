#!/usr/bin/env bun

import {
  migrationTuiUsage,
  parseMigrationTuiArguments,
} from "./cli-arguments.ts";
import { makeMigrationTuiLifecycleSupervisor } from "./lifecycle-supervisor.ts";
import { createMigrationTuiRenderSession } from "./render-session.tsx";
import { makeMigrationTuiRuntime } from "./server/tui-runtime.ts";

declare const MIGRATE_TUI_VERSION: string | undefined;

const version =
  typeof MIGRATE_TUI_VERSION === "string" ? MIGRATE_TUI_VERSION : "development";

const main = async () => {
  const parsed = parseMigrationTuiArguments(process.argv.slice(2));

  if (parsed.help) {
    process.stdout.write(`${migrationTuiUsage}\n`);
    return;
  }

  if (parsed.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const runtime = await makeMigrationTuiRuntime(
    parsed.serverUrl === undefined
      ? {
          ...(parsed.configPath === undefined
            ? {}
            : { configPath: parsed.configPath }),
          cwd: process.cwd(),
        }
      : {
          server: {
            ...(process.env.MIGRATE_SERVER_TOKEN === undefined
              ? {}
              : { bearerToken: process.env.MIGRATE_SERVER_TOKEN }),
            url: parsed.serverUrl,
          },
        }
  );
  try {
    const supervisor = makeMigrationTuiLifecycleSupervisor({
      createSession: (input) =>
        createMigrationTuiRenderSession({ ...input, runtime }),
      runtime,
    });

    await supervisor.start();
    await supervisor.wait();
  } finally {
    await runtime.dispose?.();
  }
};

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`migrate-tui: ${message}\n`);
  process.exitCode = 1;
});
