import type { MigrationDefinitionRegistry } from "../domain/registry.ts";

export interface MigrationCliConfig {
  readonly registry: MigrationDefinitionRegistry;
}

export const defineMigrationCliConfig = (
  config: MigrationCliConfig
): MigrationCliConfig => config;
