// biome-ignore-all lint/performance/noBarrelFile: CLI public entrypoint intentionally exposes the CLI-facing API.

export type { AnyMigrationDefinition } from "../domain/definition.ts";
export type { MigrationCliConfig } from "./config.ts";
export { defineMigrationCliConfig } from "./config.ts";
