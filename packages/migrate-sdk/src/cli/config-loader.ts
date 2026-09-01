import { DateTime, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { register } from "tsx/esm/api";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type { MigrationCliConfig } from "./config.ts";

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

export class MigrationCliConfigLoadError extends Schema.TaggedError<MigrationCliConfigLoadError>()(
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

export interface LoadedMigrationCliConfig {
  readonly config: MigrationCliConfig;
  readonly configPath: string;
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

  const hasRegistry =
    typeof registry === "object" &&
    registry !== null &&
    "list" in registry &&
    typeof (registry as MigrationDefinitionRegistry).list === "function";

  if (!hasRegistry) {
    return false;
  }

  if (!("sqlStore" in value) || value.sqlStore === undefined) {
    return true;
  }

  const sqlStore = value.sqlStore;

  return (
    typeof sqlStore === "object" &&
    sqlStore !== null &&
    "clientLayer" in sqlStore &&
    Layer.isLayer(sqlStore.clientLayer) &&
    (!("tablePrefix" in sqlStore) ||
      sqlStore.tablePrefix === undefined ||
      typeof sqlStore.tablePrefix === "string")
  );
};

const resolveExplicitConfigPath = (
  path: Path.Path,
  cwd: string,
  configPath: string
): string =>
  path.isAbsolute(configPath) ? configPath : path.resolve(cwd, configPath);

const safeExists = (
  fs: FileSystem.FileSystem,
  path: string
): Effect.Effect<boolean> => Effect.orElseSucceed(fs.exists(path), () => false);

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
        message: "Unable to access migration config path",
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
  path: Path.Path,
  directory: string
): Effect.Effect<boolean> => {
  const packageJsonPath = path.join(directory, "package.json");

  return Effect.orElseSucceed(
    Effect.gen(function* () {
      const exists = yield* fs.exists(packageJsonPath);

      if (!exists) {
        return false;
      }

      const content = yield* fs.readFileString(packageJsonPath);

      return hasPackageWorkspaces(content);
    }),
    () => false
  );
};

const isWorkspaceRoot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const hasPnpmWorkspace = yield* safeExists(
      fs,
      path.join(directory, "pnpm-workspace.yaml")
    );

    if (hasPnpmWorkspace) {
      return true;
    }

    return yield* isPackageWorkspaceRoot(fs, path, directory);
  });

const discoverConfigPath = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string
): Effect.Effect<string, MigrationCliConfigLoadError> => {
  const find = (
    directory: string
  ): Effect.Effect<string, MigrationCliConfigLoadError> =>
    Effect.gen(function* () {
      for (const fileName of CONFIG_FILE_NAMES) {
        const candidate = path.join(directory, fileName);
        const exists = yield* configPathExists(fs, candidate);

        if (exists) {
          return candidate;
        }
      }

      const parentDirectory = path.dirname(directory);
      const isFileSystemRoot = parentDirectory === directory;
      const shouldStop =
        isFileSystemRoot || (yield* isWorkspaceRoot(fs, path, directory));

      if (shouldStop) {
        return yield* new MigrationCliConfigLoadError({
          configPath: cwd,
          kind: "NoConfigFound",
          message: "No migration config was found",
        });
      }

      return yield* find(parentDirectory);
    });

  return find(path.resolve(cwd));
};

const importConfigModule = (
  path: Path.Path,
  configPath: string
): Effect.Effect<unknown, MigrationCliConfigLoadError> =>
  Effect.gen(function* () {
    const importFailed = (cause: unknown) =>
      new MigrationCliConfigLoadError({
        cause,
        configPath,
        kind: "ConfigImportFailed",
        message: "Failed to import migration config",
      });
    const configUrl = yield* path.toFileUrl(configPath).pipe(
      Effect.map((url) => url.href),
      Effect.mapError(importFailed)
    );
    const importModule = (load: () => Promise<unknown>) =>
      Effect.tryPromise({
        try: load,
        catch: importFailed,
      });

    const now = yield* DateTime.now;
    const load = () =>
      import(`${configUrl}?migrateSdkCli=${DateTime.toEpochMillis(now)}`);

    if (Reflect.has(globalThis, "Bun")) {
      return yield* importModule(load);
    }

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => register()),
      () => importModule(load),
      (unregister) => Effect.promise(() => unregister())
    );
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
        message: "Migration config must be exported as the default export",
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
          "Migration config must be synchronous; async config factories are not supported",
      })
    );
  }

  if (!isMigrationCliConfig(config)) {
    return Effect.fail(
      new MigrationCliConfigLoadError({
        configPath,
        kind: "InvalidConfig",
        message:
          "Migration config must be created with defineMigrationCliConfig({ registry, executableLayer?, sqlStore? })",
      })
    );
  }

  return Effect.succeed(config);
};

export const loadMigrationCliConfigWithPath = ({
  configPath,
  cwd,
}: LoadMigrationCliConfigInput): Effect.Effect<
  LoadedMigrationCliConfig,
  MigrationCliConfigLoadError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolvedConfigPath =
      configPath === undefined
        ? yield* discoverConfigPath(fs, path, cwd)
        : resolveExplicitConfigPath(path, cwd, configPath);
    const exists = yield* configPathExists(fs, resolvedConfigPath);

    if (!exists) {
      return yield* new MigrationCliConfigLoadError({
        configPath: resolvedConfigPath,
        kind: "ConfigPathNotFound",
        message: "Migration config file was not found",
      });
    }

    const moduleValue = yield* importConfigModule(path, resolvedConfigPath);
    const config = yield* readDefaultExport(resolvedConfigPath, moduleValue);

    return { config, configPath: resolvedConfigPath };
  });

export const loadMigrationCliConfig = (
  input: LoadMigrationCliConfigInput
): Effect.Effect<
  MigrationCliConfig,
  MigrationCliConfigLoadError,
  FileSystem.FileSystem | Path.Path
> =>
  loadMigrationCliConfigWithPath(input).pipe(
    Effect.map((loaded) => loaded.config)
  );
