import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Context, Effect, Layer, type Scope } from "effect";
import {
  loadMigrationCliConfigWithPath,
  type MigrationCliConfig,
} from "../cli/index.ts";
import {
  type AnySelfContainedMigrationDefinition,
  MigrationExecutable,
} from "../index.ts";
import {
  makeRegistryMigrateServerRuntime,
  type RegistryMigrateServerRuntime,
  type RegistryMigrateServerRuntimeOptions,
} from "./registry-runtime.ts";

type LocalMigrateServerConfig = MigrationCliConfig<
  readonly AnySelfContainedMigrationDefinition[]
>;

export interface LoadLocalMigrateServerRuntimeInput
  extends RegistryMigrateServerRuntimeOptions {
  readonly configPath?: string;
  readonly cwd: string;
}

export interface LocalMigrateServerRuntime
  extends RegistryMigrateServerRuntime {
  readonly configPath: string;
}

export const loadLocalMigrateServerRuntime = (
  input: LoadLocalMigrateServerRuntimeInput
): Effect.Effect<LocalMigrateServerRuntime, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const loaded = yield* loadMigrationCliConfigWithPath({
      ...(input.configPath === undefined
        ? {}
        : { configPath: input.configPath }),
      cwd: input.cwd,
    }).pipe(Effect.provide(nodeServicesLayer));
    const config = loaded.config as LocalMigrateServerConfig;
    const executable =
      config.executableLayer === undefined
        ? MigrationExecutable.inlineService
        : Context.get(
            yield* Layer.build(config.executableLayer),
            MigrationExecutable
          );
    const runtime = makeRegistryMigrateServerRuntime({
      executable,
      ...(input.progressFallbackIntervalMs === undefined
        ? {}
        : { progressFallbackIntervalMs: input.progressFallbackIntervalMs }),
      ...(input.providerSettlementGraceMs === undefined
        ? {}
        : { providerSettlementGraceMs: input.providerSettlementGraceMs }),
      registry: config.registry,
      ...(input.terminalPollIntervalMs === undefined
        ? {}
        : { terminalPollIntervalMs: input.terminalPollIntervalMs }),
    });

    return { ...runtime, configPath: loaded.configPath };
  });
