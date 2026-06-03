# Effect Service Migration Definitions

We will model the migration framework around executable TypeScript migration definitions, with source plugins, destination plugins, and migration stores exposed as Effect services implemented by layers. This keeps the first version strongly typed, composable, and usable from both CLI and SDK entrypoints, while leaving room for future serializable migration specs that compile through a plugin registry into executable definitions.

## Status

Accepted

## Considered Options

- Executable TypeScript migration definitions using Effect services and layers.
- Serializable migration specs as the primary v1 API.
- Generic core create/update destination operations.
- Destination-specific commands executed by destination plugins.

## Decision

The v1 runtime API uses executable `MigrationDefinition` objects. A definition wires one source plugin layer, one destination plugin layer, one migration store layer, and an Effect pipeline. The pipeline transforms a source item into a destination command, and the destination plugin executes that command.

Serializable `MigrationSpec` documents are reserved for future YAML, database, UI, or low-code workflows. A future plugin registry can compile those specs into executable migration definitions, but the registry is not required for the first code path.

Destination behavior is represented as destination-specific commands rather than generic core `create` or `update` operations. This lets plugins model operations such as upsert, update, publish, update-and-publish, or future stubbing without forcing every destination system into the same lifecycle.

Public and persisted data uses domain-friendly discriminators such as `kind` and `status`, not Effect's internal `_tag` convention. Effect `_tag` remains appropriate for Effect-native typed errors such as `SkipItem`, where APIs like `Effect.catchTag` provide useful ergonomics. Public examples should use helpers such as `skipItem(...)` so users do not author `_tag` directly.

The migration store owns durable item state, run state, source cursors, and migration definition locks. Source and destination plugins do not own migration progress.

## Consequences

- The CLI and SDK can share the same runner because both invoke the same executable migration definitions.
- Strong TypeScript inference remains central to the v1 API.
- Future DSL or UI support will need a compile step from migration specs to migration definitions.
- Destination plugins carry more responsibility for destination-specific command semantics.
- The core runner can stay focused on orchestration, state, locks, retries, and item outcomes.
- Public command and state shapes remain friendly to JSON, YAML, CLI output, and future UI workflows.
