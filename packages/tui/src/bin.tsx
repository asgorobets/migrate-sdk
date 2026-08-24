#!/usr/bin/env bun

import { makeMigrationTuiLifecycleSupervisor } from "./lifecycle-supervisor.ts";
import { createMigrationTuiRenderSession } from "./render-session.tsx";
import { makeMigrationTuiRuntime } from "./runtime.ts";

declare const MIGRATE_TUI_VERSION: string | undefined;

const version =
  typeof MIGRATE_TUI_VERSION === "string" ? MIGRATE_TUI_VERSION : "development";

interface ParsedArguments {
  readonly configPath?: string;
  readonly help: boolean;
  readonly version: boolean;
}

const usage = `Migrate

Usage:
  migrate-tui [--config <path>]

Options:
  --config, -c  Path to migrate.config.ts, .mts, .js, or .mjs
  --help, -h    Show this help
  --version, -v Show the version`;

const parseArguments = (args: readonly string[]): ParsedArguments => {
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (argument === "--help" || argument === "-h") {
      return { help: true, version: false };
    }

    if (argument === "--version" || argument === "-v") {
      return { help: false, version: true };
    }

    if (argument === "--config" || argument === "-c") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error(`${argument} requires a path`);
      }

      configPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    help: false,
    version: false,
  };
};

const main = async () => {
  const parsed = parseArguments(process.argv.slice(2));

  if (parsed.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (parsed.version) {
    process.stdout.write(`${version}\n`);
    return;
  }

  const runtime = await makeMigrationTuiRuntime({
    ...(parsed.configPath === undefined
      ? {}
      : { configPath: parsed.configPath }),
    cwd: process.cwd(),
  });
  const supervisor = makeMigrationTuiLifecycleSupervisor({
    createSession: (input) =>
      createMigrationTuiRenderSession({ ...input, runtime }),
    runtime,
  });

  await supervisor.start();
  await supervisor.wait();
};

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`migrate-tui: ${message}\n`);
  process.exitCode = 1;
});
