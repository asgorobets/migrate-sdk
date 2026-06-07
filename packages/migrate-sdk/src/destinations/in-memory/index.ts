// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the in-memory destination API.

export { InMemoryDestinationPlugin } from "./in-memory-destination.ts";
export type {
  InMemoryDestinationTransientFailures,
  InMemoryEntryCommand,
  InMemoryEntryDestination,
  InMemoryEntryDestinationCommandOptions,
  InMemoryEntryDestinationCommands,
  InMemoryEntryDestinationOptions,
  InMemoryEntryFieldSchema,
  InMemoryPublishEntryCommand,
  InMemoryPublishEntryCommandOptions,
  InMemoryUpsertEntryCommand,
  InMemoryUpsertEntryCommandOptions,
} from "./in-memory-destination.ts";
