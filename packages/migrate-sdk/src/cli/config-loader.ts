import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect, FileSystem, Schema } from "effect";
import { register } from "tsx/esm/api";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type { MigrationCliConfig } from "./config.ts";

const tsxLoader = register({ namespace: "migrate-sdk-cli" });

const CONFIG_FILE_NAMES = [
  "migrate.config.ts",
  "migrate.config.mts",
  "migrate.config.js",
  "migrate.config.mjs",
] as const;

const MigrationCliConfigLoadErrorKind = Schema.Literals([
  "ConfigImportFailed",
  "ConfigPathAccessFailed",
  "ConfigPathNotFound",
  "DefaultExportMissing",
  "InvalidConfig",
  "NoConfigFound",
  "UnsupportedAsyncConfig",
]);

export class MigrationCliConfigLoadError extends Schema.TaggedErrorClass<MigrationCliConfigLoadError>()(
  "MigrationCliConfigLoadError",
  {
    cause: Schema.optional(Schema.Unknown),
    configPath: Schema.String,
    kind: MigrationCliConfigLoadErrorKind,
    message: Schema.String,
  }
) {}

export interface LoadMigrationCliConfigInput {
  readonly configPath?: string;
  readonly cwd: string;
}

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const isMigrationCliConfig = (value: unknown): value is MigrationCliConfig => {
  if (typeof value !== "object" || value === null || !("registry" in value)) {
    return false;
  }

  const registry = (value as { readonly registry: unknown }).registry;

  return (
    typeof registry === "object" &&
    registry !== null &&
    "list" in registry &&
    typeof (registry as MigrationDefinitionRegistry).list === "function"
  );
};

const resolveExplicitConfigPath = (cwd: string, configPath: string): string =>
  isAbsolute(configPath) ? configPath : resolve(cwd, configPath);

const safeExists = (
  fs: FileSystem.FileSystem,
  path: string
): Effect.Effect<boolean> =>
  Effect.catch(fs.exists(path), () => Effect.succeed(false));

const configPathExists = (
  fs: FileSystem.FileSystem,
  path: string
): Effect.Effect<boolean, MigrationCliConfigLoadError> =>
  Effect.mapError(
    fs.exists(path),
    (cause) =>
      new MigrationCliConfigLoadError({
        cause,
        configPath: path,
        kind: "ConfigPathAccessFailed",
        message: "Unable to access Migration CLI config path",
      })
  );

const hasPackageWorkspaces = (content: string): boolean => {
  try {
    const packageJson = JSON.parse(content) as {
      readonly workspaces?: unknown;
    };

    return packageJson.workspaces !== undefined;
  } catch {
    return false;
  }
};

const isPackageWorkspaceRoot = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<boolean> => {
  const packageJsonPath = join(directory, "package.json");

  return Effect.catch(
    Effect.gen(function* () {
      const exists = yield* fs.exists(packageJsonPath);

      if (!exists) {
        return false;
      }

      const content = yield* fs.readFileString(packageJsonPath);

      return hasPackageWorkspaces(content);
    }),
    () => Effect.succeed(false)
  );
};

const isWorkspaceRoot = (
  fs: FileSystem.FileSystem,
  directory: string
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const hasPnpmWorkspace = yield* safeExists(
      fs,
      join(directory, "pnpm-workspace.yaml")
    );

    if (hasPnpmWorkspace) {
      return true;
    }

    return yield* isPackageWorkspaceRoot(fs, directory);
  });

const discoverConfigPath = (
  fs: FileSystem.FileSystem,
  cwd: string
): Effect.Effect<string, MigrationCliConfigLoadError> => {
  const find = (
    directory: string
  ): Effect.Effect<string, MigrationCliConfigLoadError> =>
    Effect.gen(function* () {
      for (const fileName of CONFIG_FILE_NAMES) {
        const candidate = join(directory, fileName);
        const exists = yield* configPathExists(fs, candidate);

        if (exists) {
          return candidate;
        }
      }

      const parentDirectory = dirname(directory);
      const isFileSystemRoot = parentDirectory === directory;
      const shouldStop =
        isFileSystemRoot || (yield* isWorkspaceRoot(fs, directory));

      if (shouldStop) {
        return yield* new MigrationCliConfigLoadError({
          configPath: cwd,
          kind: "NoConfigFound",
          message: "No Migration CLI config was found",
        });
      }

      return yield* find(parentDirectory);
    });

  return find(resolve(cwd));
};

const importConfigModule = (
  configPath: string
): Effect.Effect<unknown, MigrationCliConfigLoadError> =>
  Effect.tryPromise({
    try: () => {
      const configUrl = pathToFileURL(configPath).href;
      const extension = extname(configPath);

      if (extension === ".ts" || extension === ".mts") {
        return tsxLoader.import(configUrl, configUrl);
      }

      return import(`${configUrl}?migrateSdkCli=${Date.now()}`);
    },
    catch: (cause) =>
      new MigrationCliConfigLoadError({
        cause,
        configPath,
        kind: "ConfigImportFailed",
        message: "Failed to import Migration CLI config",
      }),
  });

const readDefaultExport = (
  configPath: string,
  moduleValue: unknown
): Effect.Effect<MigrationCliConfig, MigrationCliConfigLoadError> => {
  if (
    typeof moduleValue !== "object" ||
    moduleValue === null ||
    !("default" in moduleValue)
  ) {
    return Effect.fail(
      new MigrationCliConfigLoadError({
        configPath,
        kind: "DefaultExportMissing",
        message: "Migration CLI config must be exported as the default export",
      })
    );
  }

  const config = moduleValue.default;

  if (isPromiseLike(config)) {
    return Effect.fail(
      new MigrationCliConfigLoadError({
        configPath,
        kind: "UnsupportedAsyncConfig",
        message:
          "Migration CLI config must be synchronous; async config factories are not supported",
      })
    );
  }

  if (!isMigrationCliConfig(config)) {
    return Effect.fail(
      new MigrationCliConfigLoadError({
        configPath,
        kind: "InvalidConfig",
        message:
          "Migration CLI config must be created with defineMigrationCliConfig({ registry, executableLayer? })",
      })
    );
  }

  return Effect.succeed(config);
};

export const loadMigrationCliConfig = ({
  configPath,
  cwd,
}: LoadMigrationCliConfigInput): Effect.Effect<
  MigrationCliConfig,
  MigrationCliConfigLoadError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const resolvedConfigPath =
      configPath === undefined
        ? yield* discoverConfigPath(fs, cwd)
        : resolveExplicitConfigPath(cwd, configPath);
    const exists = yield* configPathExists(fs, resolvedConfigPath);

    if (!exists) {
      return yield* new MigrationCliConfigLoadError({
        configPath: resolvedConfigPath,
        kind: "ConfigPathNotFound",
        message: "Migration CLI config file was not found",
      });
    }

    const moduleValue = yield* importConfigModule(resolvedConfigPath);

    return yield* readDefaultExport(resolvedConfigPath, moduleValue);
  });
