# Scoped Pipeline Tracking API

Audience: SDK users authoring migrations and plugin authors implementing destination helpers.

This document describes the public API direction from
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md).
It supersedes the command-plan identity tracking model for future tracking work.

## Goals

- Source identities can be singular or composite.
- The destination journal is the canonical destination-side tracking state.
- Tracking records are optional schema-validated materialized views over the
  journal.
- Destination helpers record destination-native changes automatically.
- Migration definitions decide whether to persist journal tracking, a projected
  tracking record, or no destination tracking.
- Destination changes use typed change descriptors, not raw change kind strings.
- Pipelines keep normal Effect ergonomics, including inline retries.
- Missing declared tracking records fail the item instead of silently writing
  incomplete migrated state.
- Advanced migrations can alias changes or record custom changes without taking
  over runtime state recording.

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
selected input before the transformation pipeline runs.

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

Identity is derived before the transformation pipeline runs. The source plugin
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

The pipeline receives that already-identified source item:

```ts
pipeline: Effect.fn(function* (source) {
  const [businessUnitKey, addressIndex] = source.identity.key
  source.item
})
```

The pipeline does not derive source identity. Do not model identity derivation
as `(sourceItem) => ...` over the `SourceItem` received by the pipeline. Model
it as `(sourcePluginSelection) => SourceIdentityKey` before the `SourceItem`
exists. Source identity must exist before pipeline execution so the runtime can
find previous item state, detect duplicate source identities, target individual
items, and persist failures even when the pipeline never starts.

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
[Effectful Pipeline Destination Capabilities](./effectful-pipeline-destination-capabilities.md).
This document owns the tracking semantics for the changes those capabilities
record.

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

## Journal Tracking

The destination journal is the canonical destination-side tracking state. A
tracked migration can choose to persist that journal without defining a separate
user-shaped tracking record:

```ts
const products = defineMigration({
  id: "products",
  source,
  store,
  tracking: Tracking.journal({
    id: "products@v1",
  }),
  pipeline: Effect.fn(function* (source) {
    yield* ct.products
      .upsert({
        key: source.item.productKey,
        name: source.item.name,
      })
      .pipe(RetryOnNetwork)
  }),
})
```

When the product helper succeeds, it records a journal entry whose value
conforms to `ct.changes.productUpserted`. The runtime persists the journal with
the item state. Rollback pipelines and inspection APIs can then read typed
changes from the persisted journal instead of depending on a single primary
destination record.

This avoids duplicating every destination change into a second user-shaped
object. If the destination-native change data is sufficient for rollback,
reference lookup, reporting, and inspection, `Tracking.journal(...)` is the
default tracked shape.

## Tracking Records

A tracking record is an optional materialized view over the destination journal.
Use one when the migration needs a durable shape that is narrower, broader, or
more domain-specific than the raw destination changes.

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

The pipeline does not return the tracking record as its success value. It stages
the record in the item execution scope with `Tracking.setRecord(...)`. The
runtime commits that staged record only after the pipeline succeeds. If the
pipeline fails before or after staging a record, the item is recorded as failed
and the staged record is not committed. The journal snapshot is still available
for failed-state persistence.

If `Tracking.record(...)` is declared and the pipeline succeeds without staging
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
and no tracking record is committed, because the pipeline failed before the
successful item boundary.

## Success Gates

Tracking mode defines what the runtime must persist after a successful
pipeline:

```ts
tracking: Tracking.journal({ id: "product-prices@v1" })
```

`Tracking.journal(...)` says a successful item must persist the destination
journal, but it does not require a materialized tracking record.

```ts
tracking: Tracking.record({
  id: "product-prices-record@v1",
  schema: ProductPricesTrackingRecord,
})
```

`Tracking.record(...)` says a successful item must persist the destination
journal and one schema-valid tracking record staged by the pipeline.

Destination changes are not a separate required map. If `ct.products.upsert`
must happen, the pipeline should make it part of the normal Effect control flow.
If it is optional, branch normally and let the journal record whichever changes
actually happened. Tracking does not need a second language for required versus
optional changes.

## Untracked Migrations

Untracked migrations still persist item progress. They opt out of destination
tracking persistence.

```ts
const publishOnly = defineMigration({
  id: "publish-only",
  source,
  store,
  tracking: Tracking.untracked(),
  pipeline: Effect.fn(function* (source) {
    yield* ct.products.publish(source.item.productKey).pipe(RetryOnNetwork)
  }),
})
```

The runtime records source identity, source version, item status, and failures.
It does not require a tracking record, does not commit the destination journal
as rollback state for successful items, and does not make the item rollbackable
through destination tracking.

## Change Aliases

Aliases are used when one pipeline records multiple changes with the same
descriptor and later code needs to distinguish them.

```ts
const master = yield* ct.products
  .upsert(source.item.masterProduct)
  .pipe(RetryOnNetwork, Tracking.as("master"))

const variant = yield* ct.products
  .upsert(source.item.variantProduct)
  .pipe(RetryOnNetwork, Tracking.as("variant"))

yield* Tracking.setRecord({
  masterProductId: master.id,
  variantProductId: variant.id,
})
```

`Tracking.as(...)` assigns a change alias in the scoped journal. It does not
change how the destination helper executes.

Aliases are useful for rollback and inspection even when no materialized
tracking record exists:

```ts
const master = yield* journal.latest(ct.changes.productUpserted, {
  alias: "master",
})
```

The runtime does not need aliases to prove a successful pipeline. If a pipeline
needs both changes, ordinary Effect control flow should make both helper calls
required before the pipeline can complete.

## Custom Changes

Custom changes are the advanced escape hatch for migration-specific outcomes
that the destination capability module cannot know.

```ts
const CustomerProductChanged = Tracking.change(
  "customer-product.product-changed@v1",
  Schema.Struct({
    productId: Schema.String,
    customerEmail: Schema.String,
  })
)
```

Pipeline:

```ts
const product = yield* ct.products
  .upsert(productDraft)
  .pipe(RetryOnNetwork)

yield* Tracking.recordChange(CustomerProductChanged, {
  productId: product.id,
  customerEmail: source.item.customerEmail,
})
```

The destination helper still records its native product change. The explicit
`Tracking.recordChange(...)` call adds migration-owned change data to the same
destination journal.

Custom changes are different from tracking records. A custom change is another
journal entry with its own descriptor schema. A tracking record is the optional
materialized item-level object declared by `Tracking.record({ id, schema })` and
staged with `Tracking.setRecord(...)`.

## Hand-Rolled Effects

Users can always write ordinary Effects:

```ts
yield* Effect.tryPromise(() =>
  rawCtClient.products().post({ body: productDraft }).execute()
)
```

That is valid pipeline code, but it records no destination-native change by
default. In a `Tracking.journal(...)` migration, the successful item is tracked
with whatever journal entries were actually recorded. In a
`Tracking.record(...)` migration, a successful item still needs a staged
schema-valid tracking record. Advanced users can record custom changes
explicitly with `Tracking.recordChange(...)`.

## Failure Semantics

For each source item, the runtime creates one pipeline execution scope and one
destination journal.

When a destination helper succeeds, it records its native change in the journal.
When a pipeline fails after one or more successful destination helpers, the
runtime persists failed item state with the recorded journal snapshot.

When a pipeline succeeds for `Tracking.journal(...)`, the runtime persists
migrated item state with the journal snapshot and no materialized tracking
record.

When a pipeline succeeds for `Tracking.record(...)`, the runtime evaluates the
staged tracking record:

- one staged record exists and schema validation succeeds: persist migrated item
  state with the journal snapshot and tracking record
- no staged record exists: persist failed item state with a tracking contract
  error
- more than one staged record exists: persist failed item state with a tracking
  contract error, unless the API later chooses last-write-wins semantics
- staged record fails schema validation: persist failed item state with a
  tracking contract error

When a pipeline succeeds for an untracked migration definition, the runtime
persists migrated item state without destination tracking.

## TypeScript Model

Destination helper return values stay typed by the helper. Destination journal
reads stay typed by the change descriptor:

```ts
const product = yield* journal.latest(ct.changes.productUpserted)

product.id
product.version
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

Migration reference lookup reads the persisted tracking state of another
migration definition. Because tracking mode is static, the lookup result can be
typed from the referenced migration definition.

For `Tracking.record(...)`, lookup returns both the persisted journal and the
schema-validated tracking record:

```ts
const migrated = yield* MigrationLookup.get(products, source.item.productId)

migrated.record.productId
migrated.journal
```

This is the recommended shape when other migrations are expected to depend on
the result. The tracking record schema becomes the referenced migration's public
lookup contract. It can be narrower than the journal and can expose stable
domain fields instead of destination-native helper results.

For `Tracking.journal(...)`, lookup returns the persisted journal without a
materialized record:

```ts
const migrated = yield* MigrationLookup.get(
  productsJournalOnly,
  source.item.productId
)

const product = yield* migrated.journal.latest(ct.changes.productUpserted)

product.id
product.version
```

This is still typed because journal reads use destination change descriptors.
It is also more coupled: the caller must know which destination change
descriptor, alias, or journal query represents the reference it needs.

For `Tracking.untracked()`, migration reference lookup should be rejected by
default because there is no durable destination tracking surface to read. A host
may still expose status-only inspection APIs for untracked migrations, but those
are not reference lookups.

The intended type shape is:

```ts
type MigrationLookupResult<M> =
  M extends MigrationDefinition<Tracking.Record<infer A>>
    ? {
        readonly source: SourceIdentitySnapshot
        readonly status: MigrationItemStatus
        readonly journal: DestinationJournalSnapshot
        readonly record: A
      }
    : M extends MigrationDefinition<Tracking.Journal>
      ? {
          readonly source: SourceIdentitySnapshot
          readonly status: MigrationItemStatus
          readonly journal: DestinationJournalSnapshot
        }
      : never
```

The SDK should not infer lookup result shape from arbitrary pipeline commands.
If a migration wants a stable downstream reference contract, it should declare
`Tracking.record({ id, schema })` and stage that record with
`Tracking.setRecord(...)`.

## Migration Contract

The migration store records a migration contract fingerprint for each migration
definition. The fingerprint includes:

- source identity contract
- tracking mode
- tracking contract id
- tracking record schema fingerprint, when the tracking mode is
  `Tracking.record(...)`

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

- Should successful `Tracking.untracked()` items discard the journal entirely,
  or may stores retain it as non-rollback diagnostic data?
- Should `Tracking.setRecord(...)` fail on multiple staged records, or should
  it use last-write-wins semantics?
- Should `Tracking.as(...)` aliases remain free-form, or should advanced users
  be able to declare alias names for contract fingerprinting?
- Should custom change descriptors carry a module id or migration id for
  diagnostics and fingerprinting?
