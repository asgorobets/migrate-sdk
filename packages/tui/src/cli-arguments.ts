export interface MigrationTuiArguments {
  readonly configPath?: string;
  readonly help: boolean;
  readonly serverUrl?: string;
  readonly version: boolean;
}

export const migrationTuiUsage = `Migrate

Usage:
  migrate-tui [--config <path>]
  migrate-tui --server <url>

Options:
  --config, -c  Path to migrate.config.ts, .mts, .js, or .mjs
  --server      Remote Migrate Server HTTP endpoint
  --help, -h    Show this help
  --version, -v Show the version

Environment:
  MIGRATE_SERVER_TOKEN  Bearer token sent to the remote Migrate Server`;

export const parseMigrationTuiArguments = (
  args: readonly string[]
): MigrationTuiArguments => {
  let configPath: string | undefined;
  let serverUrl: string | undefined;

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

    if (argument === "--server") {
      const value = args[index + 1];

      if (value === undefined) {
        throw new Error("--server requires a URL");
      }

      serverUrl = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  if (configPath !== undefined && serverUrl !== undefined) {
    throw new Error("--config and --server cannot be used together");
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    help: false,
    ...(serverUrl === undefined ? {} : { serverUrl }),
    version: false,
  };
};
