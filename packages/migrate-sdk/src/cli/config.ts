import type { Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { AnyMigrationDefinition } from "../domain/definition.ts";
import type { MigrationDefinitionRegistry } from "../domain/registry.ts";
import type { MigrationExecutable } from "../services/migration-executable.ts";

export interface MigrationCliSqlStoreConfig {
  readonly clientLayer: Layer.Layer<SqlClient.SqlClient, unknown>;
  readonly tablePrefix?: string;
}

export interface MigrationCliConfig<
  Definitions extends
    readonly AnyMigrationDefinition[] = readonly AnyMigrationDefinition[],
> {
  readonly executableLayer?: Layer.Layer<MigrationExecutable>;
  readonly registry: MigrationDefinitionRegistry<Definitions>;
  /** Explicit SQL Migration Store target for `store schema` commands. */
  readonly sqlStore?: MigrationCliSqlStoreConfig;
}

export const defineMigrationCliConfig = <
  const Definitions extends readonly AnyMigrationDefinition[],
>(
  config: MigrationCliConfig<Definitions>
): MigrationCliConfig<Definitions> => config;
