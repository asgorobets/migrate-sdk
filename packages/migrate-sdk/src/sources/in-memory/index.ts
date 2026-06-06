// biome-ignore-all lint/performance/noBarrelFile: Public subpath entrypoint intentionally re-exports the in-memory source API.

export type {
  InMemorySourceOptions,
  InMemorySourceState,
  InMemorySourceTransientFailures,
} from "./in-memory-source.ts";
export {
  InMemorySourceCursor,
  InMemorySourcePlugin,
} from "./in-memory-source.ts";
