// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the SQL source API.

export {
  SqlIdentity,
  SqlSourcePlugin,
  SqlSourcePluginName,
} from "./sql-source.ts";
export type {
  AnySqlIdentityDefinition,
  SqlIdentityColumn,
  SqlIdentityColumns,
  SqlIdentityDefinition,
  SqlSourceLookup,
  SqlSourceMetadata,
  SqlSourceMetadataContext,
  SqlSourceMetadataFailure,
  SqlSourceMetadataResult,
  SqlSourceMetadataSuccess,
  SqlSourceOptions,
  SqlSourceRead,
} from "./sql-source.ts";
