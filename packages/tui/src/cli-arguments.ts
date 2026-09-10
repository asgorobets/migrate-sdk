export interface MigrationTuiArguments {
  readonly configPath?: string;
  readonly help: boolean;
  readonly otel?: boolean;
  readonly serverUrl?: string;
  readonly version: boolean;
}

export const migrationTuiUsage = `Migrate

Usage:
  migrate-tui [--config <path>] [--otel]
  migrate-tui --server <url>

Options:
  --config, -c  Path to migrate.config.ts, .mts, .js, or .mjs
  --server      Remote Migrate Server HTTP endpoint
  --otel        Enable local OpenTelemetry traces (localhost:4318)
  --help, -h    Show this help
  --version, -v Show the version

Environment:
  MIGRATE_SERVER_TOKEN  Bearer token sent to the remote Migrate Server
  OTEL_*               Customize trace endpoint, service name, and headers`;

export const parseMigrationTuiArguments = (
  args: readonly string[]
): MigrationTuiArguments => {
  let configPath: string | undefined;
  let serverUrl: string | undefined;
  let otel = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];

    if (argument === "--otel") {
      otel = true;
      continue;
    }

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
  if (otel && serverUrl !== undefined) {
    throw new Error(
      "--otel configures local execution; configure OTEL_* on the remote Migrate Server instead"
    );
  }

  return {
    ...(configPath === undefined ? {} : { configPath }),
    help: false,
    ...(otel ? { otel } : {}),
    ...(serverUrl === undefined ? {} : { serverUrl }),
    version: false,
  };
};
