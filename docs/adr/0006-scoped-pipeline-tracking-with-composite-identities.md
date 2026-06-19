# Scoped Process Tracking With Composite Records

Migration definitions will use composite-capable source identities, scoped
process execution, and optional tracking record contracts instead of relying on
destination plugins or returned returned destination work to decide durable tracking state.
The runtime owns migration item state, while the process pipeline performs
destination effects inside a scope that records destination changes and
diagnostics in a journal; the migration definition decides whether successful
items must stage a materialized tracking record.

## Status

Accepted

## External Reference

This decision is inspired by Drupal Migrate's map-table model, where source plugins declare source ID schemas, destination plugins declare destination ID schemas, and the framework-owned ID map records source IDs, destination IDs, row status, rollback action, and row hashes. The SDK keeps the same durable-ledger idea, but adapts it for Effect process pipelines, TypeScript authoring, composite tracking records, and optional per-migration tracking record contracts.

The API direction is expanded in
[Scoped Process Tracking API](../design/scoped-pipeline-tracking-api.md) and
[Effectful Process Destination Capabilities](../design/effectful-pipeline-destination-capabilities.md).

## Considered Options

- Keep the current removed destination model where a process pipeline returns destination effects and the runtime infers one primary destination identity from identity-bearing command results.
- Let destination plugins decide whether their commands are tracked or untracked.
- Require process pipelines to return final migration outcomes.
- Use an Effect PubSub as the canonical tracking mechanism for destination changes.
- Run process pipelines inside a scoped tracking service, let destination helpers record successful changes and failed-attempt diagnostics, persist journal evidence for failed items, and allow migration definitions to stage an optional schema-validated tracking record for successful items.

## Decision

Source identity is a schema-backed contract, not just a branded string. A source
plugin may emit scalar or composite source identity values, and the framework
encodes those values into a durable source identity key for storage, lookup,
targeting, and duplicate detection. The contract is required because changing a
source identity mapping can make existing item state unsafe to reuse even when
the newly-produced encoded identities are still valid strings.

Source identity authoring standardizes on `identity.id`, `identity.schema`, and
`identity.key`. The `id` is the versioned compatibility name. The `schema`
describes the durable identity key. The `key` field is the source-plugin-owned
derivation from source-native data into a value that conforms to that schema.
Composite source identity schemas are fixed positional tuples with required
part names attached through schema metadata, not `Schema.Struct` objects.

Destination tracking is structured and may be composite. A single source item may affect multiple named destination resources, such as a product and an inventory entry, and those resources may be tracked together as one durable tracking record for that migration item. The tracking record is not limited to identity fields; it may contain created resources, affected resources, rollback buckets, audit references, or any other durable state the migration author chooses.

Process pipelines run in a per-item process execution scope.
Destination helpers are still destination-owned, schema-backed Effect
operations, but they are invoked inline instead of being returned as a command
plan. The runtime provides a scoped tracking service, implemented as
runtime-owned state such as a Ref-backed service over a destination journal and
staged tracking record slot, so destination helpers can record changes as they
succeed and diagnostics when a failed attempt needs durable context. Because the
journal belongs to the runtime scope, evidence is still available when the
process short-circuits with a typed failure.

Rollback pipelines run with their own scoped tracking service. The execution
scope separates live rollback evidence from the original process
evidence while the rollback attempt runs. If the rollback attempt fails, the
runtime preserves the original item state and appends a failed rollback attempt
journal segment. If the rollback attempt succeeds, the runtime deletes the item
state and no rollback journal evidence remains durable for that item.

Destination plugins become Effect capability modules. They own destination helpers, change descriptors, dependency layers, retryable error classification, and optional rollback helpers, but they do not own migration tracking. They are used as regular values inside the process pipeline and do not need a top-level `destination`, `destinations`, or `provide` slot on the migration definition unless the runtime has a concrete behavior that needs to inspect one.

Tracking record contracts are static on the migration definition. A migration
definition may declare `Tracking.record({ id, schema })`; if it does, a
successful item must stage exactly one schema-validated materialized tracking
record. A definition without `Tracking.record(...)` still persists migration
item progress, including source identity, source version, item status, and
failure metadata. A successful item may also persist a process journal segment
when destination helpers or diagnostics recorded one; the journal is durable
execution evidence, while the tracking record is the user-shaped success
contract.

Destination change kinds are exposed as typed destination change descriptors
owned by destination capability modules. Rollback code receives journal entries
in journal order, identifies entries with descriptor-owned predicates, and
decodes typed change values through the descriptor rather than parsing raw change
kind strings or query methods. The SDK does not try to prove that arbitrary
Effect process code records every possible destination change. Required
destination work belongs in normal Effect control flow. The item success
boundary only enforces staged record presence and schema validation when
`Tracking.record(...)` is declared.

Journal diagnostics are separate from destination changes. A failed destination
helper must not record a success change unless it knows the destination effect
completed, but it may record one generic serializable diagnostic message so
failed item state remains useful when logs are missing or unstructured.
Migration authors and destination helpers map their own Effect errors, provider
errors, or domain context into that generic diagnostic shape. Diagnostic
messages require `severity` and `message`. Severity values are `info`,
`warning`, and `error`, and the public helper maps severity to the
corresponding Effect log level. Diagnostic messages do not require stable ids or
descriptor-backed detail schemas in this slice; their details are a generic JSON
object rather than validation-oriented item error details. Durable
diagnostics do not persist raw Effect causes, thrown objects, or unstable
provider response objects.

Diagnostic authoring is compatible with Effect's logging model, not the
`Console` service. `Tracking.logDiagnostic(...)` is the public authoring API for
durable diagnostic journal entries, and the runtime may also emit SDK-marked
Effect log events for observability. The marker stays internal to the SDK in
this slice. Because `Tracking.logDiagnostic(...)` is an explicit item-state
operation, its durable journal append is not suppressed by Effect's configured
minimum log level. Ordinary logs remain observability output and do not become
migration item state.

Retries are authored inline at the destination helper call site. A process pipeline can retry exactly the effect it wants to retry, such as `ct.products.upsert(input).pipe(RetryOnNetwork)`, instead of relying on a destination-removed destination retry loop outside the process.

The migration store records a migration contract for each migration definition.
The hard migration contract covers the source identity contract, tracking
contract id, and the tracking record schema fingerprint when
`Tracking.record(...)` is declared. If the current hard contract differs from the
stored contract and any migration item state exists for the definition,
execution is blocked until the user intentionally rolls back or clears state.
Source version contracts are recorded with item state as comparability metadata:
when only source version semantics change, unchanged detection is invalidated
for read source items, and processed item state is rewritten with the current
source version contract fingerprint. A future cursor reset or full-rescan mode
can force every stored item through this rekey path.

Effect PubSub is not the canonical tracking mechanism. It is useful for optional observability, but its subscriber timing, replay, and backpressure semantics are the wrong guarantees for a durable per-item migration ledger. The runtime-owned scoped tracking service and journal are the source of truth for per-item destination evidence.

Source identity contract fingerprints are SDK-owned, not delegated to Effect as
a public hashing API. Effect Schema can provide a canonical representation of
supported identity key schemas, but the mapping contract also includes how a
source plugin derives those key parts from source-native data. Declarative
derivation options, such as CSV column mappings, are fingerprintable. Function
derivation is not reliably fingerprintable, so function-based identity
derivation must use an explicit contract id and version bump when its semantics
change.

We settled on scalar and fixed tuple source identity schemas instead of structs
because source identity is a lookup key. Positional tuples directly match
Drupal-style source ids, cache key semantics, CLI targeting, and durable
encoding: changing the order changes the identity. Struct keys make diagnostics
pleasant, but they introduce object field ordering and projection questions into
the canonical key. Required tuple part names keep the useful human-facing labels
inside the schema without making the durable key shape hierarchical.

## API Direction

```ts
const source = DocumentSourcePlugin.make({
  fetcher,
  parser,
  selector: {
    parent: (document) => document.businessUnits,
    item: (businessUnit) => businessUnit.addresses,
  },
  identity: {
    id: "business-address@v1",
    schema: SourceIdentity.tuple([
      SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
      SourceIdentity.part("addressIndex", Schema.Int),
    ]),
    key: ({ parent, item }) => [parent.key, item.index] as const,
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
})

const ct = CommercetoolsDestination.make({
  projectKey: "catalog",
}).provide(CommercetoolsLive.layer)

const migration = defineMigration({
  id: "business-addresses",
  source,
  tracking: Tracking.record({
    id: "address-entry@v1",
    schema: Schema.Struct({
      address: Schema.String,
    }),
  }),
  process: Effect.fn(function* (source) {
    const address = yield* ct.addresses
      .upsert(source.item)
      .pipe(RetryOnNetwork)

    yield* Tracking.setRecord({
      address: address.id,
    })
  }),
})
```

Composite destination tracking is explicit:

```ts
tracking: Tracking.record({
  id: "product-with-inventory@v1",
  schema: Schema.Struct({
    created: Schema.Struct({
      product: Schema.String,
    }),
    affected: Schema.Struct({
      inventory: Schema.String,
    }),
  }),
})
```

The process stages the materialized record after the required destination work:

```ts
const product = yield* ct.products.upsert(source.item.product).pipe(RetryOnNetwork)
const inventory = yield* ct.inventory.upsert(source.item.inventory).pipe(RetryOnNetwork)

yield* Tracking.setRecord({
  created: {
    product: product.id,
  },
  affected: {
    inventory: inventory.id,
  },
})
```

## Consequences

- The framework can persist partial destination changes and diagnostics for failed items without requiring user code to return a final outcome.
- A successful `Tracking.record(...)` item persists a schema-validated materialized tracking record.
- A successful item without `Tracking.record(...)` persists item progress but omits destination tracking.
- A successful progress-only item cannot be rolled back through destination tracking.
- Destination plugins become Effect capability modules rather than tracking policy owners.
- Plugin authors still own destination-native helper schemas, request construction, response parsing, change and diagnostic recording, dependency layers, and retryable error classification.
- Migration authors own orchestration, inline retries, and the explicit decision to require a materialized tracking record for successful items.
- New destination-tracking implementation work should rename the public authoring slot from `pipeline` to `process`; existing examples may keep `pipeline` only where they reflect pre-implementation code.
- Rollback reads decoded ordered journal entries from the process journal segment and narrows them with typed change descriptors and diagnostic records, not raw change kind strings.
- Failed rollback attempts preserve their own journal segments separately from the process journal segment.
- TypeScript can infer change shapes for journal reads and tracking record staging, but runtime enforcement remains responsible for staged record presence and schema validation.
- Rollback remains state-driven, but rollbackability is based on durable journal changes and optional tracking records rather than one singular primary destination identity.
- Migration reference lookup is tracking-record-driven: `Tracking.record(...)` exposes a typed record, and definitions without `Tracking.record(...)` are not lookupable by default.
- `Tracking.record(...)` is the recommended mode for migrations that are expected to become stable references for downstream migrations.
- Changing a source identity contract or tracking record contract is treated as a mapping-breaking migration definition change.
- Changing a source version contract is treated as an unchanged-detection
  boundary: previously stored source versions are non-comparable when their
  source items are processed with the current source version contract.
- Source identity schema changes, tuple part changes, and declarative source-to-key mapping changes can be detected mechanically through the migration contract fingerprint.
- Function-based source identity changes rely on explicit contract versioning because JavaScript function bodies are not stable durable contracts.
- Contract mismatches block execution when any item state exists, including failed or skipped state, because targeting, dedupe, retry, and reporting all depend on the same source identity semantics.
- Reset-style operations must be explicit: status reset releases abandoned execution state, state clearing deletes durable migration memory without touching destination data, and rollback uses durable tracking changes to compensate before deleting migration memory.
