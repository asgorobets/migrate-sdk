# Scoped Process Tracking API

Audience: SDK users authoring migrations and plugin authors implementing destination helpers.

This document describes the public API direction from
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md).
It supersedes the command-plan identity tracking model for future tracking work.
The domain term is **Process Pipeline**; examples may still show the current
`pipeline` property until the implementation renames that authoring slot to
`process`.

## Goals

- Source identities can be singular or composite.
- The destination journal records destination-side evidence inside one item
  execution scope.
- Destination journal diagnostics can preserve serializable failed-state context
  without claiming that a destination effect happened.
- Tracking records are optional schema-validated materialized state for
  successful items.
- Destination helpers record destination-native changes automatically.
- Migration definitions decide whether successful items require a projected
  tracking record.
- Destination changes use typed change descriptors, not raw change kind strings.
- Pipelines keep normal Effect ergonomics, including inline retries.
- Missing declared tracking records fail the item instead of silently writing
  incomplete migrated state.
- Repeated destination changes are interpreted through typed journal payloads
  and journal order.

## Source Identity

Source identity remains configured through source plugin options. Source plugins
own how source-native data is read and selected, so they also own the contextual
shape passed to the identity key callback. The SDK standardizes the identity
envelope all source plugins expose:

```ts
const tuple2 = <A, B>(first: A, second: B): readonly [A, B] => [
  first,
  second,
]

identity: {
  id: "business-address@v1",
  schema: SourceIdentity.tuple([
    SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
    SourceIdentity.part("addressIndex", Schema.Int),
  ]),
  key: ({ parent, item }) => tuple2(parent.key, item.index),
}
```

`identity.id` is the versioned compatibility name. `identity.schema` describes
the durable key value. `identity.key` derives that key from the source plugin's
selected input before the process pipeline runs.

The common envelope is deliberately small:

```ts
interface SourceIdentityOption<SourceSelection, Key> {
  readonly id: SourceIdentityContractId
  readonly schema: SourceIdentitySchema<Key>
  readonly key: SourceIdentityDerivation<SourceSelection, Key>
}
```

`SourceIdentityDerivation` is source-plugin specific. A document source can type
it as a callback over `{ parent, item }`; a CSV source can type it as a
declarative column mapping; a SQL source can type it as a field projection. The
shared framework contract is that the derivation produces a value matching
`identity.schema`.

Identity is derived before the process pipeline runs. The source plugin
reads from the source system, selects the source-native item context, derives
identity and version, and emits a `SourceItem`:

```ts
type SourceItem<A, Key> = {
  readonly identity: {
    readonly id: SourceIdentityContractId
    readonly key: Key
    readonly encoded: EncodedSourceIdentity
  }
  readonly item: A
  readonly version: SourceVersion
}
```

The process pipeline receives that already-identified source item:

```ts
pipeline: Effect.fn(function* (source) {
  const [businessUnitKey, addressIndex] = source.identity.key
  source.item
})
```

The process pipeline does not derive source identity. Do not model identity derivation
as `(sourceItem) => ...` over the `SourceItem` received by the process. Model
it as `(sourcePluginSelection) => SourceIdentityKey` before the `SourceItem`
exists. Source identity must exist before process execution so the runtime can
find previous item state, detect duplicate source identities, target individual
items, and persist failures even when the process never starts.

The design change is not the location of the option. The change is that the
core source identity model should preserve structured identity values and a
source identity contract instead of collapsing everything to one branded string.

### Scalar Keys

Simple source identities use `SourceIdentity.key(...)`. The helper names the key
part and carries the Effect schema used for encoding, decoding, validation, CLI
parsing, status rendering, and contract fingerprinting.

```ts
const articlesSource = DocumentSourcePlugin.make({
  fetcher,
  parser,
  selector: {
    item: (document) => document.articles,
  },
  identity: {
    id: "article@v1",
    schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
    key: ({ item }) => item.id,
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
})
```

The public value is scalar, not an array with one visible element. The SDK may
internally normalize scalar keys as one-part tuples to share metadata and
encoding machinery, but migration authors should not have to write
`[source.item.id]` for the common case.

### Composite Keys

Composite source identities use fixed positional tuples. This follows the
Drupal-style source id model and cache-key semantics: order is part of the key.
Names are still required, but they live in schema metadata on each tuple part
instead of changing the durable key shape into an object.

```ts
const businessAddressesSource = DocumentSourcePlugin.make({
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
    key: ({ parent, item }) => tuple2(parent.key, item.index),
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
})
```

`SourceIdentity.part(name, schema)` attaches the part name through Effect Schema
key annotations. The tuple index is the durable position. The part name is used
for diagnostics, status reports, CLI help, reset/rekey tooling, and contract
fingerprints. Part names are labels, not semantic lookup handles; tuple
position remains canonical.

The SDK should reject unsupported source identity schema shapes at configuration
time:

- raw `Schema.Struct` as the canonical source identity key
- tuples with unnamed parts
- optional tuple elements
- tuple rest elements
- nested object, array, or record parts on either the decoded or encoded side

Structs remain useful for source payload schemas and destination tracking records.
They are not the canonical source identity key shape because source identity is
a lookup key, and lookup keys are better represented as scalar or positional
tuple values.

### Reusable Identity Schemas

When the same identity shape is reused, migration authors can extract the
`id`/`schema` pair and still keep source-specific key derivation inside the
source plugin options:

```ts
const BusinessAddressIdentity = SourceIdentity.make({
  id: "business-address@v1",
  schema: SourceIdentity.tuple([
    SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
    SourceIdentity.part("addressIndex", Schema.Int),
  ]),
})
```

The reusable value is not tied to a source plugin. It is the durable source
identity schema contract:

```ts
interface SourceIdentityDefinition<Key> {
  readonly id: SourceIdentityContractId
  readonly kind: "scalar" | "tuple"
  readonly parts: readonly SourceIdentityPartMetadata[]
  readonly schema: SourceIdentitySchema<Key>
  readonly fingerprint: SourceIdentityContractFingerprint
}
```

`SourceIdentitySchema<Key>` is still an Effect Schema. The
`SourceIdentity.key(...)`, `SourceIdentity.part(...)`, and
`SourceIdentity.tuple(...)` helpers construct annotated Effect schemas and the
SDK derives `kind` and `parts` from that helper metadata when the identity
definition is made.

The source plugin supplies the source selection shape. The reusable identity
definition supplies the durable key shape:

```ts
const businessAddressesSource = DocumentSourcePlugin.make({
  fetcher,
  parser,
  selector: {
    parent: (document) => document.businessUnits,
    item: (businessUnit) => businessUnit.addresses,
  },
  identity: {
    ...BusinessAddressIdentity,
    key: ({ parent, item }) => tuple2(parent.key, item.index),
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
})
```

The schema describes the durable key, not the source item. The source item is
already described by the configured source plugin's `sourceSchema`. Treat that
schema as the typed field catalog for identity selection instead of adding a
second generic `fields` API.

### Plugin-Specific Key Derivation

Every source plugin exposes the same `id`/`schema`/`key` envelope, but the
`key` authoring shape can remain plugin-specific.

For CSV, identity derivation is naturally column-based. The plugin exposes a
CSV-native helper and compiles it into the shared schema-backed identity
contract internally:

```ts
const csvSource = CsvSourcePlugin.make({
  path: "business-addresses.csv",
  platform,
  dialect: { kind: "standard" },
  emptyRows: { kind: "skip" },
  headers: { kind: "from-row", rowIndex: 0 },
  identity: CsvIdentity.columns({
    id: "business-address@v1",
    columns: ["business_unit_key", "address_index"],
  }),
  version: { kind: "row-hash" },
  sourceSchema: CsvBusinessAddress,
})
```

For document sources, identity derivation is naturally selection-based. The
source plugin derives the key from the selected parent/item context before
emitting the source item:

```ts
const documentSource = DocumentSourcePlugin.make({
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
    key: ({ parent, item }) => tuple2(parent.key, item.index),
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
})
```

If a source plugin can evaluate `identity.key` against a schema cursor at
configuration time, it may mechanically fingerprint the selected paths:

```ts
{
  sourceSchema: fingerprint(compiledSelector.sourceSchema),
  identitySchema: fingerprint(identity.schema),
  identityPaths: [
    ["parent", "key"],
    ["item", "index"],
  ],
}
```

If the callback runs only against runtime source data, the function body is not
fingerprintable. The schema is still fingerprintable, but the mapping semantics
must be protected by the user-authored `identity.id` version.

## Source Identity Fingerprints

Effect Schema gives the SDK enough structure to fingerprint supported identity
key schemas, but the schema alone is not the full identity mapping.

The SDK should derive a schema fingerprint from a canonical representation of
the identity key schema. Effect exposes schema ASTs and
`SchemaRepresentation.fromAST(...)`, which can turn schema shape into
serializable data. The SDK should own the fingerprinting policy instead of
treating any Effect internal representation as the public contract.

For identity keys, keep the supported schema surface intentionally boring:

```ts
const BusinessAddressIdentitySchema = SourceIdentity.tuple([
  SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
  SourceIdentity.part("addressIndex", Schema.Int),
])
```

Prefer scalar schemas or fixed tuple parts with primitive, literal, branded,
refinement, or codec schemas whose decoded and encoded forms are still scalar.
The decoded key is the public key used by source plugins, lookup methods, and
pipelines. The encoded key is the durable lookup/index key persisted by stores
and compared by the runtime:

```ts
identity: {
  id: "business-address@v1",
  schema: BusinessAddressIdentitySchema,
  key: ({ parent, item }) => tuple2(parent.key, item.index),
}
```

The identity contract fingerprint should include at least:

- the human-authored contract id
- the canonical schema fingerprint
- the tuple part names and positions
- the plugin identity strategy
- any declarative mapping from source-native fields to identity key positions

For declarative plugins, the source-to-key mapping is fingerprintable. The
plugin should expose a source-native helper rather than asking migration authors
to assemble the low-level `SourceIdentity` envelope directly:

```ts
identity: CsvIdentity.columns({
  id: "business-address@v1",
  columns: ["business_unit_key", "address_index"],
})
```

Changing the second column from `"address_index"` to `"address_key"` changes
the derivation fingerprint. The CSV plugin still compiles the helper into a
schema-backed `SourceIdentity` contract internally.

For function-based identity derivation, the schema is fingerprintable but the
function body is not. JavaScript function source is not a stable public
contract because closures, build output, minification, and equivalent rewrites
can change or hide the semantics. Function-based identity options therefore
require the user-authored `identity.id` to carry the compatibility promise:

```ts
identity: {
  id: "business-address@v1",
  schema: BusinessAddressIdentitySchema,
  key: ({ parent, item }) => tuple2(parent.key, item.index),
}
```

If that function changes from `item.index` to `item.key`, the user must change
the contract id, or use a plugin-declarative strategy that the framework can
fingerprint mechanically.

Do not use a first-row scan as the primary drift detector. A sampled source item
can prove that a new mapping can still produce a key for that item, but it
cannot prove that the mapping is the same mapping used to write existing durable
state. It may miss drift when the first row happens to produce the same key, when
only later rows changed semantics, when source ordering changes, or when the
source data itself changed between runs. Sampling can power diagnostics such as
"old and new mappings disagree for this item", but it should not replace the
stored migration contract fingerprint.

The runtime should persist both values:

```ts
sourceIdentityContract: {
  id: "business-address@v1",
  fingerprint: "sha256:...",
}
```

The id gives humans a stable compatibility name. The fingerprint lets the
runtime detect accidental contract drift under the same id.

The migration store persists the structured source identity and an encoded
source identity key. The encoded key is used for durable lookup and internal
targeting after operator input is parsed through the source identity schema; the
structured identity remains available to tracking evaluation, rollback
pipelines, status reports, and inspection APIs.

## Source Identity Targeting

Source identity targeting uses the `--id` flag. The selected migration
definition's `identity.schema` decides how the text is parsed. Forward run
targeting is single-identity in this slice; rollback targeting may accept
multiple identities.

```sh
migrate run articles --id article-1
```

Multiple source identities for forward runs are a future capability. Supporting
them requires a plural targeted-run mode with explicit per-target lookup
failure, continuation, and reporting semantics.

Composite keys use tuple order. Part names come from schema annotations and are
used in help and error messages:

```sh
migrate run business-addresses --id 'bu-1:1'
```

Tuple text is split on `:` first, then each part is percent-decoded. A key part
that contains `:` must escape it:

```sh
migrate run business-addresses --id 'bu%3Awest:1'
```

The API contract is positional: the first token is decoded with tuple part 0,
the second token with tuple part 1, and so on. CLI tokens are parsed as encoded
schema input, decoded into the structured key, then canonicalized through the
schema encoder before targeting starts.

The CLI flow is:

1. load the registry
2. resolve exactly one migration definition
3. read that definition's source identity `id` and `schema`
4. parse each `--id` as scalar or tuple text according to the schema
5. decode and validate each value with the source identity schema
6. encode it with the SDK's canonical source identity encoder
7. pass both structured and encoded forms into item targeting

An opaque encoded id may be added later for copy/paste from status output. It is
not required for the initial public targeting shape.

The source plugin API should evolve from accepting only a branded string to
accepting a structured target:

```ts
interface SourceIdentityTarget<Key> {
  readonly id: SourceIdentityContractId
  readonly key: Key
  readonly encoded: EncodedSourceIdentity
}

interface SourcePlugin<A, Cursor, SourceInput, Key> {
  readonly readByIdentity: (
    identity: SourceIdentityTarget<Key>
  ) => Effect.Effect<SourceItem<SourceInput> | null, SourcePluginError>
}
```

Source plugins should not need to parse their own encoded identity strings. The
runtime decodes the target through the configured source identity contract before
calling `readByIdentity`.

For scan-only sources, targeted lookup may still scan from the beginning and
derive identities until it finds a matching encoded key. This is slow but
correct when the source has no direct lookup primitive:

```ts
lookup: { kind: "scan" }
```

For direct lookup sources, the plugin can use the structured key to fetch the
smallest source resource it can address. For a business address source, the
direct lookup may destructure the tuple, use `businessUnitKey` to fetch one
business unit, and use `addressIndex` to select the nested address:

```ts
lookup: {
  kind: "direct",
  read: ({ key: [businessUnitKey, addressIndex] }) =>
    api.getBusinessUnit({ key: businessUnitKey }).pipe(
      Effect.map((businessUnit) => businessUnit.addresses[addressIndex])
    )
}
```

Page or cursor location should not be part of source identity unless the source
system itself treats that location as durable identity. For paged APIs,
`pageNumber`, cursor offsets, and fetcher cursors are discovery mechanics, not
source identity. A scannable source should normally identify the second address
as:

```ts
["bu-1", 1]
```

not:

```ts
["bu-1", 1, 2]
```

If the source has no direct lookup by `businessUnitKey`, targeted runs for that
identity use scan lookup and search all pages. If scan lookup is too expensive,
the source plugin needs a direct lookup strategy or an external source index.

## Destination Change Descriptors

Destination capability modules own change descriptors for destination-native
outcomes they can record. A destination change is a typed, destination-native
outcome recorded by a successful destination helper because it may be needed for
tracking, rollback, or inspection. It is not necessarily a structural diff.

```ts
const ProductUpserted = DestinationChangeDescriptor.make(
  "commercetools.product-upserted",
  Schema.Struct({
    id: Schema.String,
    key: Schema.String,
    outcome: Schema.Literal("created", "updated", "unchanged"),
    version: Schema.Number,
  })
)

const InventoryEntryUpserted = DestinationChangeDescriptor.make(
  "commercetools.inventory-entry-upserted",
  Schema.Struct({
    id: Schema.String,
    outcome: Schema.Literal("created", "updated", "unchanged"),
    sku: Schema.String,
    version: Schema.Number,
  })
)
```

Configured destination capability modules expose those descriptors through a
typed change catalog:

```ts
const ct = CommercetoolsDestination.make({
  projectKey: "catalog",
}).provide(CommercetoolsLive.layer)

ct.changes.productUpserted
ct.changes.inventoryEntryUpserted
```

Change descriptors are stable public API. Migration authors should reference
`ct.changes.productUpserted`, not `"commercetools.product-upserted"`.

The destination capability and dependency model is specified in
[Effectful Process Destination Capabilities](./effectful-pipeline-destination-capabilities.md).
This document owns the tracking semantics for the changes those capabilities
record.

## Scoped Tracking Service

The runtime provides a process-facing `Tracking` service for each item
execution. The service owns the scoped destination journal and the staged
tracking record slot.

Destination helpers use that service to record destination-native changes and
explicitly marked generic diagnostics. Migration authors use the same service
to stage `Tracking.record(...)` values and map process failures into generic
diagnostics when they use hand-rolled Effects.

The service is scoped to one migration definition and one source item. It may
be implemented from runtime context that also has access to the migration store,
but the process-facing API does not expose arbitrary migration-store writes.
The runtime remains responsible for deciding what item state is persisted after
the process exits.

Diagnostic capture should be compatible with Effect's logging model, not the
`Console` service. The runtime can install an item-scoped logger that merges
with existing loggers and observes SDK-marked diagnostic log events for normal
observability. The marker is internal; the public authoring surface is
`Tracking.logDiagnostic(...)`. Ordinary `Effect.log*` calls and `Console.*`
output remain observability, not durable item state.

Because `Tracking.logDiagnostic(...)` is an explicit item-state operation, the
durable journal append is not filtered by Effect's configured minimum log level.
The helper may still emit a normal Effect log event at the requested severity,
but that observability event is separate from the journal write.

## Automatic Changes

Destination helpers record their plugin-native changes automatically when the
destination operation succeeds.

```ts
yield* ct.products
  .upsert({
    key: source.item.productKey,
    name: source.item.name,
  })
  .pipe(RetryOnNetwork)
```

The product upsert helper records a change that conforms to
`ct.changes.productUpserted`. The migration author does not need to wrap the
helper just to make baseline destination state durable.

If the helper fails, no success change is recorded for that helper. If the
helper succeeds and a later helper fails, the successful change remains in the
scoped destination journal and can be persisted with the failed item state.

A failed helper may record a destination journal diagnostic with normalized
serializable error details. That diagnostic explains the failed attempt, but it
is not a destination change and does not make the item rollbackable by itself.
Raw Effect causes, thrown objects, and unstable provider response objects should
stay in logs rather than durable journal diagnostics.

## Journal Diagnostics

Journal diagnostics are for failed-state inspection and rollback planning when
logs are unavailable, suppressed, or too unstructured to explain what happened.
They preserve context, not destination effects.

This slice uses one generic diagnostic message shape. Migration authors and
destination helpers map their own Effect errors, provider errors, and domain
context into that shape instead of declaring per-domain diagnostic descriptors.
The message has required `severity`, `message`, and optional `details`.
Supported severities are `info`, `warning`, and `error`; the helper maps them
to the matching Effect log level when it emits the marked log event. The message
has no stable `id`; if users cannot react to it programmatically, an `id`
becomes a pseudo-contract. Details are a generic JSON object, not
descriptor-discriminated data and not the validation-oriented
`MigrationItemErrorDetail[]` shape.

The author-facing helper is expected to create a durable diagnostic journal
entry and may also emit an explicitly marked Effect log event:

```ts
yield* Tracking.logDiagnostic({
  severity: "error",
  message: "Could not normalize address before Commercetools upsert",
  details: {
    businessUnitKey: source.item.businessUnitKey,
    addressIndex: source.item.addressIndex,
  },
})
```

The same mapping can live inside a destination helper:

```ts
const address = yield* ct.businessUnits.upsertAddress(input).pipe(
  Effect.tapError((error) =>
    Tracking.logDiagnostic({
      severity: "error",
      message: "Commercetools address upsert failed",
      details: ct.errors.toDiagnosticDetails(error),
    })
  )
)
```

The SDK-owned diagnostic marker is not public in this slice. Advanced users
still use `Tracking.logDiagnostic(...)`; raw `Effect.log*` calls are not
captured into the journal.

If a process records only diagnostics and then fails, the failed item state may
persist the journal for inspection. Rollback code should treat diagnostics as
context, not compensation instructions. A rollback pipeline may still use the
diagnostics to decide to no-op, surface a manual correction message, or choose a
destination cleanup path based on separately recorded destination changes.

## Journal Segments

Each process pipeline and rollback pipeline gets its own scoped tracking
service. The scope is the live capture boundary; the durable item state keeps
that boundary visible as journal segments.

```ts
interface DestinationJournal {
  readonly process: DestinationJournalSegment
  readonly rollbackAttempts: readonly RollbackAttemptJournalSegment[]
}

interface DestinationJournalSegment {
  readonly runId: MigrationRunId
  readonly entries: readonly DestinationJournalEntry[]
}

interface RollbackAttemptJournalSegment extends DestinationJournalSegment {
  readonly failedAt: Date
  readonly error?: MigrationItemError
}
```

Rollback code reads original migration evidence from
`state.journal.process.entries`. Previous failed rollback attempts remain
available under `state.journal.rollbackAttempts`.

When rollback succeeds, the runtime deletes the whole item state, including all
journal segments. When rollback fails, the runtime preserves the original item
state and appends one rollback attempt segment with that attempt's journal
entries and failure metadata.

## Progress-Only Successful Items

A migration definition does not need to declare a tracking record contract. In
that case, successful items persist migration progress only: source identity,
source version, item status, and normal failure metadata when applicable.

```ts
const publishOnly = defineMigration({
  id: "publish-only",
  source,
  store,
  pipeline: Effect.fn(function* (source) {
    yield* ct.products.publish(source.item.productKey).pipe(RetryOnNetwork)
  }),
})
```

Destination helpers may still record entries into the scoped destination
journal while the process runs. If the item succeeds and no tracking record
contract exists, the runtime does not promote the journal into successful
destination tracking state in this slice. If the item fails after one or more
helpers succeeded, the failed item state may preserve the journal as partial
failure evidence for rollback and inspection.

## Tracking Records

A tracking record is optional materialized state for successful items. Use one
when the migration needs a durable shape that is narrower, broader, or more
domain-specific than destination-native helper results.

```ts
const ProductTrackingRecord = Schema.Struct({
  productId: Schema.String,
  productKey: Schema.String,
})

const products = defineMigration({
  id: "products",
  source,
  store,
  tracking: Tracking.record({
    id: "product-record@v1",
    schema: ProductTrackingRecord,
  }),
  pipeline: Effect.fn(function* (source) {
    const product = yield* ct.products
      .upsert({
        key: source.item.productKey,
        name: source.item.name,
      })
      .pipe(RetryOnNetwork)

    yield* Tracking.setRecord({
      productId: product.id,
      productKey: product.key,
    })
  }),
})
```

`tracking.schema` validates the persisted tracking record. The record can be a
single reference, a composite set of references, created/affected buckets,
rollback instructions, audit data, or any other durable item-level state the
migration author wants to persist.

The process pipeline does not return the tracking record as its success value. It stages
the record in the item execution scope with `Tracking.setRecord(...)`. The
runtime commits that staged record only after the process succeeds. If the
process fails before or after staging a record, the item is recorded as failed
and the staged record is not committed. The process journal segment is still
available for failed-state persistence.

This makes the tracking record the stable contract for successful item state.
The journal remains durable evidence for inspection and rollback, especially
when a process partially succeeds and then fails before a successful record can
be committed.

If `Tracking.record(...)` is declared and the process succeeds without staging
a record, the item is recorded as failed with a tracking contract error. The
runtime does not silently write migrated item state with missing declared
tracking data.

## Composite Tracking Records

One source item may affect multiple destination resources. The journal records
the destination-native changes individually; the optional tracking record can
materialize the migration author's preferred aggregate shape.

```ts
const ProductInventoryTrackingRecord = Schema.Struct({
  created: Schema.Struct({
    product: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
    }),
  }),
  affected: Schema.Struct({
    inventory: Schema.Struct({
      id: Schema.String,
      sku: Schema.String,
    }),
  }),
})

const productsWithInventory = defineMigration({
  id: "products-with-inventory",
  source,
  store,
  tracking: Tracking.record({
    id: "product-with-inventory@v1",
    schema: ProductInventoryTrackingRecord,
  }),
  pipeline: Effect.fn(function* (source) {
    const product = yield* ct.products
      .upsert(source.item.product)
      .pipe(RetryOnNetwork)

    const inventory = yield* ct.inventory
      .upsert(source.item.inventory)
      .pipe(RetryOnNetwork)

    yield* Tracking.setRecord({
      created: {
        product: {
          id: product.id,
          key: product.key,
        },
      },
      affected: {
        inventory: {
          id: inventory.id,
          sku: inventory.sku,
        },
      },
    })
  }),
})
```

If product upsert succeeds and inventory upsert fails, the failed item state
preserves the product change in the journal. The item is not marked migrated,
and no tracking record is committed, because the process failed before the
successful item boundary.

## Success Gates

The optional tracking record contract defines what extra durable destination
state the runtime must persist after a successful process.

A definition without `Tracking.record(...)` is progress-only on success. It does
not require a tracking record and does not persist the scoped journal as
successful destination tracking state in this slice.

```ts
tracking: Tracking.record({
  id: "product-prices-record@v1",
  schema: ProductPricesTrackingRecord,
})
```

`Tracking.record(...)` says a successful item must persist one schema-valid
tracking record staged by the process.

Destination changes are not a separate required map. If `ct.products.upsert`
must happen, the process should make it part of the normal Effect control flow.
If it is optional, branch normally and let the journal record whichever changes
actually happened. Tracking does not need a second language for required versus
optional changes.

## Repeated Destination Changes

If one process records multiple changes with the same descriptor, rollback and
inspection code reads the ordered typed entries and uses the change payload to
distinguish them.

```ts
const productChanges = state.journal.process.entries.filter(
  ct.changes.productUpserted.is
)

const master = productChanges.find(
  (entry) => entry.value.role === "master"
)
```

Destination change descriptors should model the stable destination-specific data
needed to interpret repeated entries, such as resource ids, keys, roles, or
address identifiers. The tracking API does not add a second string-labeling
system on top of descriptor payloads.

The runtime does not need repeated-entry labels to prove a successful process.
If a process needs multiple destination changes, ordinary Effect control flow
should make those helper calls required before the process can complete.

## Hand-Rolled Effects

Users can always write ordinary Effects:

```ts
yield* Effect.tryPromise(() =>
  rawCtClient.products().post({ body: productDraft }).execute()
)
```

That is valid process code, but it records no destination-native change by
default. If the definition declares `Tracking.record(...)`, a successful item
still needs a staged schema-valid tracking record. Advanced users can map
failure context into the generic diagnostic API, but hand-rolled destination
effects do not add destination-change journal entries unless they are wrapped in
a destination helper.

## Failure Semantics

For each source item, the runtime creates one process execution scope and one
process-facing tracking service backed by a destination journal and a staged
tracking record slot.

When a destination helper succeeds, it records its native change in the journal.
When a destination helper fails, it may record a diagnostic but must not record
a success change for that helper unless it knows the destination effect
completed.
When a process fails after one or more successful destination helpers, the
runtime persists failed item state with the recorded process journal segment.
The same failed-state path can persist diagnostics even when no destination
change was recorded.

When a process succeeds for `Tracking.record(...)`, the runtime evaluates the
staged tracking record:

- one staged record exists and schema validation succeeds: persist migrated item
  state with the tracking record
- no staged record exists: persist failed item state with a tracking contract
  error
- more than one staged record exists: persist failed item state with a tracking
  contract error
- staged record fails schema validation: persist failed item state with a
  tracking contract error

When a process succeeds without `Tracking.record(...)`, the runtime persists
migrated item progress without destination tracking.

## TypeScript Model

Destination helper return values stay typed by the helper. Rollback receives a
decoded destination journal with a process segment and any previous failed
rollback-attempt segments. Entries inside each segment are ordered oldest to
newest. Destination change descriptors provide predicates for narrowing entries
to typed change entries whose `value` is the descriptor payload:

```ts
const products = state.journal.process.entries.filter(
  ct.changes.productUpserted.is
)
const product = products.at(-1)

if (product) {
  product.value.id
  product.value.version
}
```

For materialized tracking records, the SDK should type
`Tracking.setRecord(...)` from the schema declared by
`Tracking.record({ id, schema })`:

```ts
tracking: Tracking.record({
  id: "products@v1",
  schema: ProductTrackingRecord,
})

yield* Tracking.setRecord({
  productId: product.id,
  productVersion: product.version,
})
```

The SDK should also validate that the staged tracking record conforms to
`tracking.schema` before persisting migrated item state.

The SDK should not try to prove that arbitrary `Effect.gen` code always emits
specific changes. Normal Effect code can branch, loop, call helper functions,
retry, recover, or short-circuit in ways TypeScript cannot soundly analyze.

Required work should be expressed by normal Effect control flow. Tracking
record presence and schema validity are enforced at the item success boundary.

## Migration Reference Lookup

Migration reference lookup reads the persisted tracking record of another
migration definition. Because the tracking record contract is static, the lookup
result can be typed from the referenced migration definition.

For `Tracking.record(...)`, lookup returns the schema-validated tracking record:

```ts
const migrated = yield* MigrationLookup.get(products, source.item.productId)

migrated.record.productId
```

This is the recommended shape when other migrations are expected to depend on
the result. The tracking record schema becomes the referenced migration's public
lookup contract. It can be narrower than the journal and can expose stable
domain fields instead of destination-native helper results.

Definitions without `Tracking.record(...)` are rejected by migration reference
lookup by default because there is no durable destination reference contract to
read. A host may still expose status-only inspection APIs for progress-only
migrations, but those are not reference lookups.

The intended type shape is:

```ts
type MigrationLookupResult<M> =
  M extends MigrationDefinition<Tracking.Record<infer A>>
    ? {
        readonly source: SourceIdentitySnapshot
        readonly status: MigrationItemStatus
        readonly record: A
      }
    : never
```

The SDK should not infer lookup result shape from arbitrary process commands.
If a migration wants a stable downstream reference contract, it should declare
`Tracking.record({ id, schema })` and stage that record with
`Tracking.setRecord(...)`.

## Migration Contract

The migration store records a migration contract fingerprint for each migration
definition. The fingerprint includes:

- source identity contract
- tracking contract id
- tracking record schema fingerprint, when `Tracking.record(...)` is declared

If the current migration contract differs from the stored contract and any item
state exists for the migration definition, execution is blocked. The user must
roll back, clear durable migration state, or run a future explicit rekey/reset
operation.

Source version contracts are handled as item-level comparability metadata rather
than as hard migration contract blockers. Each item state records the source
version contract fingerprint that produced its `sourceVersion`. A migrated item
is counted as unchanged only when both the `sourceVersion` value and the stored
source version contract fingerprint match the current source item and
definition. When only the source version contract changes, runs process read
source items and rewrite their item state with the current source version
contract fingerprint. A future cursor reset or full-rescan mode can force every
stored item through this rekey path.

## Open Questions

No open questions remain in this slice.
