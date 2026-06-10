// biome-ignore-all lint/performance/noBarrelFile: Testing entrypoint intentionally exposes the CLI command test surface.

export { migrateCommand } from "./command.ts";
export { MigrationCliRuntime } from "./runtime.ts";
