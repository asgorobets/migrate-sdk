# API Design Index

The original monolithic API design note has been split by audience. Use these
documents as the canonical design entry points:

- [Migration Author API](./migration-author-api.md) - for users writing
  migrations with configured source, destination, and store plugins.
- [Source Plugin Authoring API](./source-plugin-authoring-api.md) - for people
  implementing source plugins.
- [Destination Plugin Authoring API](./destination-plugin-authoring-api.md) -
  for people implementing destination plugins and command factories.
- [Prebuilt Plugin Usage API](./prebuilt-plugin-usage-api.md) - for migration
  authors consuming packaged plugins such as CSV, Contentful, or the in-memory
  demo plugins.
- [Runtime Internals](./runtime-internals.md) - for maintainers working on the
  runner, store, locks, state transitions, reference lookup, and future
  execution adapters.

## Shared Rules

The repo-level language source remains [CONTEXT.md](../../CONTEXT.md). The
design docs should link back to that glossary instead of duplicating every term.

Schema ownership is split by boundary:

- Source Payload Schemas live at the source boundary. They may decode
  source-native values, such as CSV strings, into the pipeline-facing values
  migration authors receive.
- Destination Command Schemas and Destination Entry Field Schemas live at the
  destination boundary. They validate pipeline-facing values and must keep the
  same TypeScript shape on both sides of the schema. Destination-native
  encoding belongs inside the destination plugin.

The first proof of concept remains focused on framework semantics: an
Effect-native runner, in-memory source and destination plugins, a file-backed
migration store, cursor windows, run modes, retry wrappers, skip behavior,
definition locks, reference lookup, and durable item state transitions.
