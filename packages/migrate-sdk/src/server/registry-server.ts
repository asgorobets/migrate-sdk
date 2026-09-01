import { type Duration, Effect, Layer, Option } from "effect";
import {
  type AnySelfContainedMigrationDefinition,
  type MigrationDefinitionRegistry,
  MigrationExecutable,
} from "../index.ts";
import type { MigrateEnvironmentInfo } from "../protocol/index.ts";
import { makeRegistryMigrateServerBackend } from "./registry-backend.ts";
import {
  makeRegistryMigrateServerRuntime,
  type RegistryMigrateServerRuntimeOptions,
} from "./registry-runtime.ts";
import { MigrateServer } from "./service.ts";

export interface RegistryMigrateServerLayerOptions
  extends RegistryMigrateServerRuntimeOptions {
  readonly dashboardFallbackInterval?: Duration.Input;
  readonly dashboardProjectionInterval?: Duration.Input;
  readonly environment: MigrateEnvironmentInfo;
  readonly observationLeaseDuration?: Duration.Input;
  readonly registry: MigrationDefinitionRegistry<
    readonly AnySelfContainedMigrationDefinition[]
  >;
}

const layer = (
  options: RegistryMigrateServerLayerOptions
): Layer.Layer<MigrateServer, never, MigrationExecutable> =>
  Layer.effect(
    MigrateServer,
    Effect.gen(function* () {
      const executable = yield* MigrationExecutable;
      const runtime = makeRegistryMigrateServerRuntime({
        executable,
        ...(options.progressFallbackIntervalMs === undefined
          ? {}
          : {
              progressFallbackIntervalMs: options.progressFallbackIntervalMs,
            }),
        ...(options.providerSettlementGraceMs === undefined
          ? {}
          : {
              providerSettlementGraceMs: options.providerSettlementGraceMs,
            }),
        registry: options.registry,
        ...(options.terminalPollIntervalMs === undefined
          ? {}
          : { terminalPollIntervalMs: options.terminalPollIntervalMs }),
      });
      const registryId = Option.getOrUndefined(options.registry.id());

      return yield* MigrateServer.make({
        backend: makeRegistryMigrateServerBackend(runtime),
        dashboardFallbackInterval: options.dashboardFallbackInterval,
        dashboardProjectionInterval: options.dashboardProjectionInterval,
        environment: options.environment,
        observationLeaseDuration: options.observationLeaseDuration,
        ...(registryId === undefined ? {} : { registryId }),
      });
    })
  );

/**
 * Constructs a migration server directly from a definition registry and an
 * execution adapter. Registry and implementation identity are derived by this
 * module. Network transport and authorization remain separate host concerns
 * layered on top of the returned server service.
 */
export const RegistryMigrateServer = { layer } as const;
