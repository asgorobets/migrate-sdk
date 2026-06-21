import type { Layer } from "effect";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type { MigrationExecutable } from "../services/migration-executable.ts";

export interface MigrationCliConfig {
  readonly executableLayer?: Layer.Layer<MigrationExecutable>;
  readonly registry: MigrationDefinitionRegistry;
}

export const defineMigrationCliConfig = (
  config: MigrationCliConfig
): MigrationCliConfig => config;
