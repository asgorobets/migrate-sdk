# API Design Index

The original monolithic API design note has been split by audience. Use these
documents as the canonical design entry points:

- [Migration Author API](./migration-author-api.md) - for users writing
  migrations with configured source, destination, and store capabilities.
- [Source Authoring API](./source-authoring-api.md) - for people
  implementing sources.
- [Destination Authoring API](./destination-authoring-api.md) -
  for people implementing destinations and command factories.
- [Prebuilt Destination Helper Usage](./prebuilt-destination-helper-usage.md) - for migration
  authors consuming SDK-provided capabilities such as CSV, Contentful, or the
  in-memory demo capabilities.
- [CSV Source Design](./csv-source.md) - source-specific
  decisions for the first real source tracer bullet.
- [Package Export Architecture](./package-export-architecture.md) - the
  Effect-inspired one-package export shape to refactor toward after CSV.
- [Runtime Internals](./runtime-internals.md) - for maintainers working on the
  runner, store, locks, state transitions, reference lookup, and future
  execution adapters.

## Shared Rules

The repo-level language source remains [CONTEXT.md](../../CONTEXT.md). The
design docs should link back to that glossary instead of duplicating every term.

The SDK should remain one installable package for core runtime APIs and
first-party sources and destinations as long as possible. Keep destinations
internally clean and tree-shakable through explicit public exports; split
packages only when a platform implementation or hard dependency boundary makes
that necessary. The target export layout is captured in
[Package Export Architecture](./package-export-architecture.md).

Schema ownership is split by boundary:

- Source Payload Schemas live at the source boundary. They may decode
  source-native values, such as CSV strings, into the pipeline-facing values
  migration authors receive.
- Destination Entry Field Schemas and typed change descriptors live at the
  destination boundary. They validate pipeline-facing values and must keep the
  same TypeScript shape on both sides of the schema. Destination-native
  encoding belongs inside the destination.

The first proof of concept remains focused on framework semantics: an
Effect-native runner, in-memory source and destination, a file-backed
migration store, cursor windows, run modes, retry wrappers, skip behavior,
definition locks, reference lookup, and durable item state transitions.
