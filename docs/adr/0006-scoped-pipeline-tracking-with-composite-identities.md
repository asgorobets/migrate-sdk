# Scoped Pipeline Tracking With Composite Records

Migration definitions will use composite-capable source identities, scoped pipeline execution, and explicit tracking modes instead of relying on destination plugins or returned command plans to decide durable tracking state. The runtime owns migration item state, while the pipeline performs destination effects inside a scope that records destination changes in a journal; the migration definition then decides whether to persist the journal, stage a materialized tracking record, or omit destination tracking.

## Status

Accepted

## External Reference

This decision is inspired by Drupal Migrate's map-table model, where source plugins declare source ID schemas, destination plugins declare destination ID schemas, and the framework-owned ID map records source IDs, destination IDs, row status, rollback action, and row hashes. The SDK keeps the same durable-ledger idea, but adapts it for Effect pipelines, TypeScript authoring, composite tracking records, explicit tracking modes, and optional per-migration tracking record contracts.

The API direction is expanded in
[Scoped Pipeline Tracking API](../design/scoped-pipeline-tracking-api.md) and
[Effectful Pipeline Destination Capabilities](../design/effectful-pipeline-destination-capabilities.md).

## Considered Options

- Keep the current command-plan model where a transformation pipeline returns destination commands and the runtime infers one primary destination identity from identity-bearing command results.
- Let destination plugins decide whether their commands are tracked or untracked.
- Require transformation pipelines to return final migration outcomes.
- Use an Effect PubSub as the canonical tracking mechanism for destination changes.
- Run pipelines inside a scoped runtime journal, let destination helpers record changes, persist the journal as the canonical destination tracking state, and allow migration definitions to stage an optional schema-validated tracking record.

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

Transformation pipelines run in a per-item pipeline execution scope. Destination helpers are still destination-owned, schema-backed Effect operations, but they are invoked inline instead of being returned as a command plan. The runtime provides a scoped destination journal, implemented as runtime-owned state such as a Ref-backed service, so destination helpers can record changes as they succeed. Because the journal belongs to the runtime scope, changes are still available when the pipeline short-circuits with a typed failure.

Destination plugins become Effect capability modules. They own destination helpers, change descriptors, dependency layers, retryable error classification, and optional rollback helpers, but they do not own migration tracking. They are used as regular values inside the pipeline and do not need a top-level `destination`, `destinations`, or `provide` slot on the migration definition unless the runtime has a concrete behavior that needs to inspect one.

Tracking is static on the migration definition. A migration definition chooses
one of three modes:

- `Tracking.journal({ id })` persists the destination journal as the canonical
  destination tracking state.
- `Tracking.record({ id, schema })` persists the destination journal plus one
  schema-validated materialized tracking record staged by the pipeline.
- `Tracking.untracked()` persists item progress without destination tracking.

Untracked does not mean ephemeral. The runtime still persists migration item state for untracked migration definitions, including source identity, source version, item status, and failure metadata. Untracked only opts out of destination tracking.

Destination change kinds are exposed as typed destination change descriptors
owned by destination capability modules. Journal reads and rollback helpers
reference those descriptors rather than raw change kind strings, so TypeScript
can infer change value types without requiring a custom pipeline DSL. The SDK
does not try to prove that arbitrary Effect pipeline code records every
possible destination change. Required destination work belongs in normal Effect
control flow. The item success boundary only enforces the selected tracking
mode: journal persistence for `Tracking.journal(...)`, staged record presence
and schema validation for `Tracking.record(...)`, and no destination tracking
for `Tracking.untracked()`.

Retries are authored inline at the destination helper call site. A pipeline can retry exactly the effect it wants to retry, such as `ct.products.upsert(input).pipe(RetryOnNetwork)`, instead of relying on a destination-command-plan retry loop outside the pipeline.

The migration store records a migration contract for each migration definition.
The contract covers the source identity contract, source version contract,
tracking mode, tracking contract id, and the tracking record schema fingerprint
when `Tracking.record(...)` is used. If the current contract differs from the
stored contract and any migration item state exists for the definition,
execution is blocked until the user intentionally rolls back or clears state.

Effect PubSub is not the canonical tracking mechanism. It is useful for optional observability, but its subscriber timing, replay, and backpressure semantics are the wrong guarantees for a durable per-item migration ledger. The runtime-owned scoped journal is the source of truth for destination changes.

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
  pipeline: Effect.fn(function* (source) {
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

The pipeline stages the materialized record after the required destination work:

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

When destination-native journal entries are enough, no materialized record is
needed:

```ts
tracking: Tracking.journal({ id: "products@v1" })
```

Side-effect-only migrations are explicit too:

```ts
tracking: Tracking.untracked()
```

## Consequences

- The framework can persist partial destination changes for failed items without requiring user code to return a final outcome.
- A successful `Tracking.journal(...)` item persists the journal as its durable destination tracking state.
- A successful `Tracking.record(...)` item persists the journal and a schema-validated materialized tracking record.
- A successful untracked migration item persists item progress but omits destination tracking.
- An untracked migration item cannot be rolled back through destination tracking unless the user records other durable state intentionally.
- Destination plugins become Effect capability modules rather than tracking policy owners.
- Plugin authors still own destination-native helper schemas, request construction, response parsing, change recording, dependency layers, and retryable error classification.
- Migration authors own orchestration, inline retries, and the explicit decision to persist journal tracking, a materialized tracking record, or no destination tracking.
- Journal reads and rollback helpers reference typed change descriptors, not raw change kind strings.
- TypeScript can infer change shapes for journal reads and tracking record staging, but runtime enforcement remains responsible for staged record presence and schema validation.
- Rollback remains state-driven, but rollbackability is based on durable journal changes and optional tracking records rather than one singular primary destination identity.
- Migration reference lookup is tracking-mode-driven: `Tracking.record(...)` exposes a typed record plus journal, `Tracking.journal(...)` exposes typed journal access only, and `Tracking.untracked()` is not lookupable by default.
- `Tracking.record(...)` is the recommended mode for migrations that are expected to become stable references for downstream migrations.
- Changing a source identity contract, source version contract, tracking mode, or tracking contract is treated as a mapping-breaking migration definition change.
- Source identity schema changes, tuple part changes, and declarative source-to-key mapping changes can be detected mechanically through the migration contract fingerprint.
- Function-based source identity changes rely on explicit contract versioning because JavaScript function bodies are not stable durable contracts.
- Contract mismatches block execution when any item state exists, including failed or skipped state, because targeting, dedupe, retry, and reporting all depend on the same source identity semantics.
- Reset-style operations must be explicit: status reset releases abandoned execution state, state clearing deletes durable migration memory without touching destination data, and rollback uses durable tracking changes to compensate before deleting migration memory.
