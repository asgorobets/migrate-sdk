// biome-ignore-all lint/performance/noBarrelFile: CLI public entrypoint intentionally exposes the CLI-facing API.

export type { AnyMigrationDefinition } from "../domain/definition.ts";
export type {
  MigrationCliConfig,
  MigrationCliSqlStoreConfig,
} from "./config.ts";
export { defineMigrationCliConfig } from "./config.ts";
export {
  type LoadedMigrationCliConfig,
  type LoadMigrationCliConfigInput,
  loadMigrationCliConfig,
  loadMigrationCliConfigWithPath,
  MigrationCliConfigLoadError,
} from "./config-loader.ts";
