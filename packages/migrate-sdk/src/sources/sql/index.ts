// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the SQL source API.

export {
  SqlIdentity,
  SqlSource,
  SqlSourceName,
} from "./sql-source.ts";
export type {
  AnySqlIdentityDefinition,
  SqlIdentityColumn,
  SqlIdentityColumns,
  SqlIdentityDefinition,
  SqlSourceCount,
  SqlSourceCountEffect,
  SqlSourceCountStatement,
  SqlSourceEffectCount,
  SqlSourceLookup,
  SqlSourceMetadata,
  SqlSourceMetadataContext,
  SqlSourceMetadataFailure,
  SqlSourceMetadataResult,
  SqlSourceMetadataSuccess,
  SqlSourceOptions,
  SqlSourceRead,
  SqlSourceStatementCount,
} from "./sql-source.ts";
