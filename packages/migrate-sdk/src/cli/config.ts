import type { Layer } from "effect";
import type { AnyMigrationDefinition } from "../domain/definition.ts";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type { MigrationExecutable } from "../services/migration-executable.ts";
import type { SqlMigrationStoreSchemaConfig } from "../stores/sql/sql-migration-store-schema-plan.ts";

export interface MigrationCliSqlStoreConfig
  extends SqlMigrationStoreSchemaConfig {}

export interface MigrationCliConfig<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly executableLayer?: Layer.Layer<MigrationExecutable>;
  readonly registry: MigrationDefinitionRegistry<Definitions>;
  /** SQL Migration Store target for CLI and server schema administration. */
  readonly sqlStore?: MigrationCliSqlStoreConfig;
}

export const defineMigrationCliConfig = <
  const Definitions extends readonly AnyMigrationDefinition[],
>(
  config: MigrationCliConfig<Definitions>
): MigrationCliConfig<Definitions> => config;
