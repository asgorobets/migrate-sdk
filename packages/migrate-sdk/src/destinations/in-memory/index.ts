// biome-ignore-all assist/source/organizeImports: Public feature entrypoint is grouped by API audience.
// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the in-memory destination API.

export { InMemoryDestinationPlugin } from "./in-memory-destination.ts";
export type {
  InMemoryDestinationEntry,
  InMemoryDestinationExecute,
  InMemoryDestinationExecution,
  InMemoryDestinationFixture,
  InMemoryDestinationInspection,
  InMemoryDestinationOptions,
  InMemoryDestinationTransientFailures,
  InMemoryEntryCommand,
  InMemoryEntryDestination,
  InMemoryEntryDestinationCommands,
  InMemoryEntryDestinationFixture,
  InMemoryEntryDestinationOptions,
  InMemoryEntryFieldSchema,
  InMemoryEntryFieldSchemas,
  InMemoryPublishEntryCommand,
  InMemoryUpsertEntryCommand,
} from "./in-memory-destination.ts";
