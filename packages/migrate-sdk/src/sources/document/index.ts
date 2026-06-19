// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the document source API.

export {
  DocumentFetchers,
  DocumentFileTextFetcherCursor,
} from "./document-fetcher.ts";
export { DocumentParsers } from "./document-parser.ts";
export { DocumentSourcePlugin } from "./document-source.ts";
export type {
  DocumentEffectFetcherLayerOptions,
  DocumentEffectFetcherOptions,
  DocumentFetcher,
  DocumentFetcherPlatform,
  DocumentFetcherTotalDiscoveryCapability,
  DocumentFetchResult,
  DocumentFileTextFetcherOptions,
} from "./document-fetcher.ts";
export type { DocumentParser } from "./document-parser.ts";
export type {
  DocumentSourceCursor,
  DocumentSourceDirectLookupResult,
  DocumentSourceIdentity,
  DocumentSourceIdentityScalar,
  DocumentSourceIdentityValue,
  DocumentSourceItemSelector,
  DocumentSourceLookup,
  DocumentSourceSchema,
  DocumentSourceSchemaCursor,
  DocumentSourceSchemaSelection,
  DocumentSourceSelectedItem,
  DocumentSourceSelectedSubitem,
  DocumentSourceSubitemSelector,
  DocumentSourceTotalCallback,
  DocumentSourceTotalContext,
  DocumentSourceVersion,
} from "./document-source.ts";
