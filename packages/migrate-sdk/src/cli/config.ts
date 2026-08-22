import type { Layer } from "effect";
import type { AnyMigrationDefinition } from "../domain/definition.ts";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type { MigrationExecutable } from "../services/migration-executable.ts";

export interface MigrationCliConfig<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly executableLayer?: Layer.Layer<MigrationExecutable>;
  readonly registry: MigrationDefinitionRegistry<Definitions>;
}

export const defineMigrationCliConfig = <
  const Definitions extends readonly AnyMigrationDefinition[],
>(
  config: MigrationCliConfig<Definitions>
): MigrationCliConfig<Definitions> => config;
