// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the SQL source API.

export {
  SqlSourcePlugin,
  SqlSourcePluginName,
} from "./sql-source.ts";
export type { SqlSourceOptions } from "./sql-source.ts";
