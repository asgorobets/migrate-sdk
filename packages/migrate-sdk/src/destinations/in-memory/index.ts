// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the in-memory destination API.

export { InMemoryDestination } from "./in-memory-destination.ts";
export type {
  InMemoryEntryDestinationModule,
  InMemoryEntryDestinationModuleOptions,
  InMemoryDestinationTransientFailures,
  InMemoryEntryFieldSchema,
  InMemoryEntryUpsertedChange,
} from "./in-memory-destination.ts";
