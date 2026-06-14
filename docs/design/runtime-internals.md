# Runtime Internals

Audience: maintainers of the runner, store implementations, and runtime
extension points.

Status: pre-ADR-0006 command-plan runtime notes. This document describes the
older runtime model that executes destination command plans and persists one
primary destination identity. The target runtime direction is refined by
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md),
[Scoped Pipeline Tracking API](./scoped-pipeline-tracking-api.md), and
[Effectful Pipeline Destination Capabilities](./effectful-pipeline-destination-capabilities.md).
Do not treat the destination command-plan sections below as the new public API.

This document intentionally sits behind the public authoring docs. Migration
authors should start with [Migration Author API](./migration-author-api.md).

## Runtime Services

`SourcePlugin`, `DestinationPlugin`, and `MigrationStore` are Effect service
boundaries. Configured plugins carry layers; the runner provides the source,
destination, reference lookup, and store layers for each migration definition.

The Effect Context tags are not generic at runtime, so service values carry the
generic shape and the runner narrows them at the migration definition boundary.

## Store Boundary

`MigrationStore` is the single public store service. Implementations may split
item state, run state, cursors, and lock storage internally.

The store owns:

- encoded source cursors by migration definition
- migration item states by definition and source identity
- migration run state
- definition locks

Run-level store failures stop the migration run. The runner must not continue
producing destination side effects when it cannot write durable progress,
failure, run, cursor, or lock records.

All selected and dependency-expanded definitions in one run must use the same
store layer instance. This keeps locks, run state, item states, and cursors in
one durability boundary.

Read-only status inspection does not use the run lifecycle and does not require
selected definitions to share one store layer. It reads each migration
definition's own store independently.

Status uses two store-level aggregate/read primitives:

```ts
interface MigrationItemStateSummary {
  readonly migrated: number;
  readonly skipped: number;
  readonly failed: number;
  readonly needsUpdate: number;
}

interface MigrationStore {
  readonly getLatestRunState: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<MigrationRunState | null, MigrationStoreError>;

  readonly getItemStateSummary: (
    definitionId: MigrationDefinitionId
  ) => Effect.Effect<MigrationItemStateSummary, MigrationStoreError>;
}
```

`getItemStateSummary` avoids materializing all item states for cheap
durable-only status. File and in-memory stores may implement it by counting
`listItemStates(definitionId)` internally. SQL and key/value stores can provide
native grouped counts. `listItemStates(definitionId)` remains the detail API for
rollback and source-scan status paths that need durable source identities.

## Runner Order

High-level single-definition order:

```txt
decode stored source cursor
read one source cursor window
for each emitted source item:
  process source item
commit next source cursor after the window
repeat until source returns no next cursor
```

`processSourceItem` order:

```txt
read previous item state
decode source payload with Source Payload Schema
skip unchanged migrated or skipped state unless the run mode forces reprocessing
run the transformation pipeline
normalize SkipItem into skipped item state
normalize pipeline errors into failed item state
validate and execute the destination command plan
normalize destination errors into failed item state
persist migrated item state with destination identity and version
```

The runner continues after item failures and marks the definition failed at the
summary level when any selected item failed.

The next cursor is committed after a window is processed, even when some items
in that window failed. Failed items are retried from durable item state using
`readByIdentity`, so one permanently bad item does not pin cursor advancement.

## Source Boundary

Cursor reads are discovery. If `SourcePlugin.read(cursor)` fails, the migration
definition run fails because the runner does not know which source identities
were selected.

Identity lookups are item-specific after the source identity is already known.
`readByIdentity(identity)` receives a decoded source identity target and powers
failed reruns, skipped reruns, needs-update backlog, and item mode. Lookup
failures can be recorded as item failures.

Source payload decoding happens before unchanged-terminal checks, pipeline
execution, and destination command execution. A source item with a valid
identity and version but invalid payload becomes a failed item state with source
error details.

The current runtime sees source read and lookup failures as `SourcePluginError`.
A future source contract may keep plugin-specific error channels available to
source retry strategies before normalizing those errors at the framework
boundary for run failures, item failures, CLI rendering, and durable item error
records.

## Status Inspection

Status inspection is read-only. It must not:

- acquire migration definition locks
- create a run id
- begin, fail, or complete run state
- read or write persisted source cursor progress
- write item state
- execute transformation pipelines
- call destination plugins

Durable-only status reads latest run lifecycle metadata and aggregate item-state
counts from the migration store.

Source-scan status additionally scans the current source inventory. It starts at
`source.read(null)`, follows returned `nextCursor` values until the source is
exhausted, and never reads or writes the persisted source cursor. A status scan
over multiple migration definitions may run definition scans concurrently, with
a default concurrency of `1`. Each individual definition still reads its cursor
windows sequentially.

Source-scan status validates each emitted source item payload with the
migration definition's source payload schema. Invalid payloads are returned as
schema-backed status warnings and counted in source status; they are not
persisted as failed item states. Duplicate source identities in the same full
scan are also returned as schema-backed warnings. Source cursor read failures
fail the status request because the inventory scan cannot complete.

The first source-scan implementation may materialize
`listItemStates(definitionId)` to compute orphaned durable states exactly.
Future large-store implementations can add pagination or store-native scan
optimizations when real pressure appears, but the first public status API does
not add a separate batch item-state lookup primitive.

## Destination Command Plans

The runner normalizes a destination command plan into an array, then validates
and executes it sequentially.

Validation rules:

- empty plans fail the item
- more than one identity-bearing command fails the item
- more than one produced destination identity fails the item

Side-effect-only command results can omit destination identity. The runner keeps
the latest destination identity and version produced by the plan. A migrated item
must end with a destination identity, either from this run or from a previous
eligible item state.

Destination retry wraps individual command execution through the migration
definition's `destinationRetry` function.

## Item State

Durable item state is discriminated by `status`:

- `migrated`
- `skipped`
- `failed`
- `needs-update`

`unchanged` is a run outcome, not a persisted status. The durable item state
remains the prior terminal state.

Migration item state does not store source item payload snapshots by default.
Payloads can be large or sensitive, and the source system remains the source of
truth. Retrying failed, skipped, needs-update, or single-item work uses
`SourcePlugin.readByIdentity`.

Live Effect causes are useful for logging, but durable migration item error
records should store normalized, inspectable error details rather than raw
causes.

## Orphan Cleanup Direction

Ordinary migration reruns must not implicitly delete destination content when a
source item disappears. Source plugins report the current source truth through
`readByIdentity`; they do not own rollback or dangling-destination cleanup
semantics.

Future orphan cleanup belongs to an explicit SDK or CLI command that compares
durable migration item mappings against the current source and removes
destinations whose Source Identity no longer exists. This is an architecture
concern across all source plugins, not a CSV source-plugin concern.

## Multi-Definition Runs

`runMigrations` accepts multiple definitions. It expands selected definition ids
through `dependsOn`, rejects missing dependencies and dependency cycles, orders
the expanded set topologically, and runs definitions sequentially in V1.

One `MigrationRunId` covers the whole run. Store run state is keyed by every
definition id in the run.

The runner acquires all definition locks before executing any definition. If it
cannot acquire the full set, it releases any acquired locks and fails before
destination side effects.

## Definition Locks

V1 uses durable definition-level locks. Two runners must not execute the same
migration definition at the same time.

Lock records include:

```ts
interface MigrationDefinitionLock {
  readonly createdAt: Date;
  readonly definitionId: MigrationDefinitionId;
  readonly ownerRunId: MigrationRunId;
  readonly token: MigrationDefinitionLockToken;
}
```

Locks do not auto-expire in durable stores. Abandoned locks require an explicit
force-unlock workflow with the lock token. This is safer than allowing a stalled
runner and a new runner to write state and destination side effects
concurrently.

SQL stores can acquire locks with atomic insert. KV stores can use `SET NX`.
File stores can use exclusive creation for local development.

## Reference Lookup And Stubs

`MigrationReferenceLookup` reads migrated destination identities from migration
item state. It may target one definition id or an ordered list of definition
ids. For multiple definition ids, lookup returns the first migrated or
needs-update reference found in lookup order.

A declared dependency gives same-run ordering and locking guarantees, but lookup
itself can target definitions that are not declared dependencies.

When lookup is configured with `stub: true`, the referenced migration definition
must provide a `stub` hook. Stub creation runs in a scoped migration run for the
referenced definition and records a `needs-update` item state with a usable
destination identity. The source identity is enough to create the stub; the full
referenced source payload is not required.

## Execution Adapter Direction

The current runtime is inline. Future execution adapters may own scheduling,
partitioning, bounded concurrency, queues, serverless continuation, and timeout
handling.

Adapters must preserve core semantics:

- source identity and source version handling
- item state statuses
- destination command result persistence
- dependency ordering or equivalent safety
- lock or claim safety rules

Future durable execution should split the V1 definition-level lock into a
discovery lock and item-level claims. Source snapshots may be useful for queue
payloads, but they are not migration item state and would need retention,
encryption, and expiry policies.

## Future Spec Direction

Future YAML, DB, UI, or low-code workflows can compile serializable migration
specs into executable migration definitions through a plugin registry.

The plugin registry is future DSL infrastructure. It is not required for the
first TypeScript code path.
