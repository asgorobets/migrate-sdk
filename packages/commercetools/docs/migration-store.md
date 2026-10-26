# Commercetools Migration Store

Status: implementation guide.

Audience: migration authors and maintainers shaping the
`@migrate-sdk/commercetools` package.

This document captures the intended shape for a native Commercetools
`MigrationStore` backed by Custom Objects. The goal is to let Commercetools
migration projects keep durable migration state inside Commercetools itself,
similar in spirit to Terraform state, without requiring a separate database.

Related runtime design: [Runtime Internals](../../../docs/design/runtime-internals.md).

## Problem

The core runtime already treats `MigrationStore` as the durable boundary for:

- encoded source cursors
- migration item state
- latest run state
- definition locks

Commercetools users may not want to provision a separate SQL database, Redis
instance, or shared filesystem just to run migrations. Custom Objects are a
good native fit because they store JSON documents, are addressable by
`container` and `key`, and support optimistic concurrency through object
versions.

The store should be useful for destination-only migrations today and should not
be coupled to destination internals. Future sources and destination
sources and destinations should be able to share the same store package slice.

## Package Boundary

The migration store should be a separate public subpath export:

```json
{
  "exports": {
    "./migration-store": "./src/migration-store/index.ts"
  }
}
```

Migration authors import it independently from source and destination:

```ts
import {
  CommercetoolsMigrationStore,
} from "@migrate-sdk/commercetools/migration-store";
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { Layer } from "effect";

const sdkLayer = CommercetoolsSdk.layerFromApiRoot({
  apiRoot,
  projectKey,
});

const storeLayer = CommercetoolsMigrationStore.layer({
  container: "migrate-sdk",
  namespace: "catalog-import",
}).pipe(Layer.provide(sdkLayer));
```

The store depends on `CommercetoolsSdk`. It does not take a destination
instance as input. This lets users store migration state in the same project as
the destination, or provide a separate SDK layer for a dedicated state project.

### Same Project For Destination And State

Use one SDK layer when the destination data and migration state should live in
the same Commercetools project. Build the layer once and reuse that same layer
reference for both the destination and store wiring:

```ts
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import {
  CommercetoolsMigrationStore,
} from "@migrate-sdk/commercetools/migration-store";
import { Layer } from "effect";

const commercetoolsSdkLayer = CommercetoolsSdk.layerFromApiRoot({
  apiRoot,
  projectKey: "destination-project",
});

const storeLayer = CommercetoolsMigrationStore.layer({
  container: "migrate-sdk",
  namespace: "catalog-import",
}).pipe(Layer.provide(commercetoolsSdkLayer));

const ct = CommercetoolsDestination.make().provide(commercetoolsSdkLayer);
```

Pass `storeLayer` to every migration definition in the same execution. The core
runtime expects one shared `MigrationStore` layer per run so definition locks,
source cursors, run state, and item state all agree on the same durable backend.

An ergonomic convenience is available when only the store needs a layer:

```ts
const storeLayer = CommercetoolsMigrationStore.layerFromApiRoot({
  apiRoot,
  projectKey,
  container: "migrate-sdk",
  namespace: "catalog-import",
});
```

### Separate State Project

Use separate SDK layers when migration state belongs in a dedicated operational
project, or when migrating between Commercetools projects and the state should
not be written to the destination project:

```ts
import { CommercetoolsSdk } from "@migrate-sdk/commercetools";
import { CommercetoolsDestination } from "@migrate-sdk/commercetools/destination";
import {
  CommercetoolsMigrationStore,
} from "@migrate-sdk/commercetools/migration-store";
import { Layer } from "effect";

const destinationSdkLayer = CommercetoolsSdk.layerFromApiRoot({
  apiRoot: destinationApiRoot,
  projectKey: "destination-project",
});

const stateSdkLayer = CommercetoolsSdk.layerFromApiRoot({
  apiRoot: stateApiRoot,
  projectKey: "migration-state-project",
});

const storeLayer = CommercetoolsMigrationStore.layer({
  container: "migrate-sdk",
  namespace: "catalog-import",
}).pipe(Layer.provide(stateSdkLayer));

const ct = CommercetoolsDestination.make().provide(destinationSdkLayer);
```

The state project needs Custom Object read/write scopes. The destination
project needs whatever scopes the destination helpers require, such as product
write scopes for product catalog migrations.

## Public API

The first public API should stay small:

```ts
export interface CommercetoolsMigrationStoreOptions {
  readonly container?: string;
  readonly namespace?: string;
  readonly pageSize?: number;
}

export const CommercetoolsMigrationStore: {
  readonly layer: (
    options?: CommercetoolsMigrationStoreOptions
  ) => Layer.Layer<MigrationStore, MigrationStoreError, CommercetoolsSdk>;

  readonly layerFromApiRoot: (
    options: CommercetoolsSdkLayerOptions & CommercetoolsMigrationStoreOptions
  ) => Layer.Layer<MigrationStore, MigrationStoreError>;
};
```

Defaults:

- `container`: `"migrate-sdk"`
- `namespace`: `"default"`
- `pageSize`: `500`

Item-state summaries use one GraphQL request containing separate selections for
`migrated`, `failed`, `skipped`, and `needs-update`. Commercetools filters the
existing `value.index.status` on the server; each selection returns only the
page count and object keys. The response never includes `value`, so status reads
and run preparation do not download or decode tracking records or journals.

Each selection uses `pageSize` and an independent keyset cursor. Subsequent
requests include only statuses with more pages. Counts are accumulated from the
returned records, not the provider's estimated or capped `total`. A metadata
check in the first request rejects unsupported record formats, missing or
unknown statuses, and disagreement between indexed and stored statuses. GraphQL
errors and incomplete or non-advancing pages fail the summary rather than
returning partial counts.

This optimization uses the existing format-version-1 objects and needs no
storage upgrade or backfill. It does not change the public `MigrationStore`
interface. Summary reads validate count metadata rather than the full payload;
`getItemState` and `listItemStates` still decode and validate full item states.
Counts are eventually consistent across concurrent writes. A status change
during a scan can temporarily count an item in two buckets or miss it; a new
scan returns the settled counts once writes stop. Cursors use stable object
keys rather than modification timestamps, which can change during traversal.
Full item-state listing still collects full values.

The implementation should validate `container` and `namespace` before building
the layer. Commercetools Custom Object `container` and `key` values have a
restricted character set and length limits. Keys are generated by the store, but
the configured namespace is part of those keys.

## Storage Model

The default storage model should use one Custom Object per logical store
record. Avoid one giant state object as the default.

Custom Objects have a hard JSON document size limit, and Commercetools
recommends keeping persisted JSON documents much smaller for good performance.
Record-per-state keeps item writes small and avoids making every migration item
contend on one Custom Object.

The store uses a configured `container` and generated keys:

```txt
<namespace>__encoded-source-cursor__definition-hash_<hash>
<namespace>__latest-run-state__definition-hash_<hash>
<namespace>__migration-item-state__definition-hash_<hash>__source-identity-hash_<hash>
<namespace>__migration-definition-lock__definition-hash_<hash>
```

Examples:

```txt
catalog-import__encoded-source-cursor__definition-hash_J8GvAmXGmXhMu0BB
catalog-import__latest-run-state__definition-hash_J8GvAmXGmXhMu0BB
catalog-import__migration-item-state__definition-hash_J8GvAmXGmXhMu0BB__source-identity-hash_1vaBLmAH3zS_WMMD
catalog-import__migration-definition-lock__definition-hash_J8GvAmXGmXhMu0BB
```

The delimiter is `__`. It remains readable when user-provided namespaces
contain dots or hyphens. The keys should be treated as generated addresses, not
as the source of truth. Human-readable metadata belongs in the Custom Object
value.

Dynamic key parts are hashed into safe, bounded segments. Raw `definitionId`
and `sourceIdentity` values may be too long or may contain characters not
allowed by Commercetools keys.

Choose `container` as the Commercetools Custom Object bucket for migration
state, for example `migrate-sdk` or `migrate-sdk-state`. Choose `namespace` as
the collision boundary inside that bucket, for example `catalog-import`,
`catalog-import-dev`, or `catalog-import-prod`. Use a different namespace when
two unrelated migration projects share one state project. Keep the namespace
stable for the lifetime of a migration because it is part of every generated
key.

## Record Envelopes

All Custom Object values should be schema-backed envelopes:

```ts
interface StoreRecordEnvelope<A> {
  readonly formatVersion: 1;
  readonly namespace: string;
  readonly recordKind: string;
  readonly index?: Record<string, string | number | boolean | undefined>;
  readonly state: A;
}
```

Record kinds:

```ts
type CommercetoolsMigrationStoreRecordKind =
  | "manifest"
  | "encoded-source-cursor"
  | "latest-run-state"
  | "migration-item-state"
  | "migration-definition-lock";
```

Item state records include original lookup metadata even though the key uses
hashes. Records should also duplicate important query fields into a scalar
`index` object:

```ts
{
  formatVersion: 1,
  namespace: "catalog.import",
  recordKind: "migration-item-state",
  index: {
    definitionId: "products",
    sourceIdentityHash: "id_a81b",
    status: "migrated",
    lastRunId: "run-123",
  },
  state: {
    definitionId: "products",
    sourceIdentity: "sku-123",
    status: "migrated",
    // ...
  },
}
```

The `index` object is denormalized on purpose. It gives the store simple,
stable fields for Custom Object query predicates without making query behavior
depend on every nested runtime state shape. Index fields should stay scalar:
strings, numbers, booleans, and dates encoded as strings. The canonical data
still lives in `state`.

Commercetools does not persist object fields with `null` values inside Custom
Object values. The adapter handles this at its storage boundary; domain schemas
keep their required and nullable fields.

All reads and writes use one private Effect codec per record schema. Older
records without null metadata decode through a derived storage schema: required
fields whose codecs accept null use `Schema.withDecodingDefaultKey` to supply
missing null values. Nested fields, encoded property names, optional absence,
existing defaults, refinements and transformations retain their contracts.
The adapter does not decode, catch a failure, repair the value and retry.

New writes include a private `nullFields` envelope property, including an empty
list when there are no nulls. The codec records null-valued object keys and
omits them from the stored object. Null array entries use a non-null placeholder
with their exact positions recorded in the same metadata. The provider receives
no raw null values, so preservation does not depend on how deeply it omits nulls
or how it treats array entries. Decoding restores the exact values and removes
the metadata before applying the original record schema. This preserves optional
nulls and arbitrary tracking records, destination journal changes and journal
extensions without passing their user-supplied schemas into the store.

Metadata presence selects the storage representation before domain decoding.
Current records must satisfy the original domain schema after restoration;
missing fields are not repaired by the older-record schema. Older representations
are read-only, so all writes use the lossless codec. Existing null metadata remains
readable. Index and state fields stay queryable in their existing locations, and
`formatVersion` remains `1`. User schemas and the `MigrationStore` interface do
not change.

Older arbitrary JSON payloads without metadata cannot have unknown missing keys
reconstructed: an absent key and a removed null are indistinguishable. Malformed
metadata and attempts to overwrite existing non-null object values are rejected.
Array restoration requires an existing placeholder or null at the recorded
position. Decoding never writes back to Commercetools.

## Locking

Definition locks use one Custom Object per locked definition:

```txt
<namespace>__migration-definition-lock__definition-hash_<hash>
```

Lock acquisition uses Commercetools create-if-absent semantics by posting the
Custom Object with `version: 0`.

```ts
await sdk.request("customObjects.createDefinitionLock", (project) =>
  project.customObjects().post({
    body: {
      container,
      key: lockKey(definitionId),
      version: 0,
      value: {
        formatVersion: 1,
        namespace,
        recordKind: "migration-definition-lock",
        index: {
          definitionId,
          ownerRunId,
        },
        state: {
          createdAt,
          definitionId,
          ownerRunId,
          token,
        },
      },
    },
  })
);
```

Expected behavior:

- success means the lock was acquired
- concurrent modification means another runner owns the lock
- other SDK errors become `MigrationStoreError`

Lock release reads the existing lock, verifies the owner token, and deletes the
Custom Object by current version:

```txt
GET lock object
decode lock record
verify token and ownerRunId
DELETE lock object with current version
```

Locks do not auto-expire. This matches the core runtime contract for durable
stores: abandoned locks require an explicit force-unlock workflow so a stalled
runner and a new runner cannot write state and destination side effects
concurrently. Force-unlock should verify operator intent and lock ownership
metadata; it is future maintenance tooling, not part of the store runtime.

## Completion and operation history

Completion is stored in a separate `definition-completion` Custom Object. A
forward source pass reaching its end records completion even when some items
failed. Dependencies read that record independently of operation history.
New history records explicitly identify `run` or `rollback`; legacy records
without an operation remain readable with unknown intent.

After a successful rollback callback, `removeRolledBackItem` invalidates
completion and the source cursor before deleting the tracked item. Custom
Objects do not support a transaction across these records, so an interrupted
write may leave a migration incomplete and require another source pass. An
ambiguous network failure never restores completion: item deletion may already
have reached the server. Concurrent items can safely clear the shared records.
A missing item or a failed rollback callback preserves existing completion.

These additions do not require a store upgrade command. Historical records do
not establish completion automatically; run a full forward pass once to record
it. No source scan is performed when checking dependencies.

## Store Operations

The implementation maps the core `MigrationStore` service onto Custom Objects:

```txt
getDefinitionCompletion -> GET completion object, decode value
recordSourcePassCompletion -> POST completion object
getSourceCursor       -> GET cursor object, decode value
setSourceCursor       -> POST cursor object
getItemState          -> GET item object, decode value
upsertItemState       -> POST item object
removeRolledBackItem  -> GET item, invalidate completion and cursor, DELETE item by version
listItemStates        -> query item records by namespace and definition id
getItemStateSummary   -> GraphQL status-filtered key-only pages, accumulate counts
observeItemState      -> GET item object, POST current state with inventory run id
listOrphanItemStates  -> query item records not observed by the inventory run
createRunId           -> local UUID
beginRun              -> POST latest run-state records
completeRun           -> POST latest run-state records
failRun               -> POST latest run-state records
acquireDefinitionLock -> POST lock object with version: 0
releaseDefinitionLock -> DELETE lock object by version after token check
```

Ordinary cursor, item, and run-state writes do not need create-only semantics.
The runner holds definition locks before producing destination side effects, so
last-write-wins upsert is acceptable for records owned by that locked
definition.

## Listing Item State

`listItemStates(definitionId)` should query Custom Objects within the configured
container and filter by record metadata in `value`.

The first implementation can use a query shape like:

```txt
container = "migrate-sdk"
where = value(namespace = "catalog.import"
  and recordKind = "migration-item-state"
  and index(definitionId = "products"))
sort = key asc
limit = 500
withTotal = false
```

The exact predicate syntax should be verified against the Custom Objects query
API during implementation.

Offset pagination should not be used for unbounded scans. Commercetools has a
maximum offset and large offsets get slower. Instead, the Custom Object client
should use keyset pagination:

```txt
first page:
  where = value(namespace = "catalog.import"
    and recordKind = "migration-item-state"
    and index(definitionId = "products"))
  sort = key asc
  limit = 500
  withTotal = false

next page:
  where = value(namespace = "catalog.import"
    and recordKind = "migration-item-state"
    and index(definitionId = "products"))
    and key > "<last-key-from-previous-page>"
  sort = key asc
  limit = 500
  withTotal = false
```

`key` is a good cursor because Custom Object query results can be sorted by key,
and migration store keys are stable generated identifiers. This avoids the
10,000 offset ceiling and avoids duplicate rows caused by inserts ahead of the
current offset.

The core `MigrationStore` API still returns all item states for a definition at
once, so `listItemStates` will collect the internal keyset scan into an array.
That is acceptable for the first slice, but very large migrations may require
one of:

- a paged item-state listing API in core
- a public maintenance scan API that returns a stream
- key-range or shard-based record layout for very large definitions
- a separate maintenance API for export and cleanup

## Query And Scan Patterns

Direct item processing uses deterministic keys:

```txt
getSourceCursor(definitionId) -> GET <namespace>__encoded-source-cursor__definition-hash_<hash>
getItemState(definitionId, identity) -> GET <namespace>__migration-item-state__definition-hash_<hash>__source-identity-hash_<hash>
acquireDefinitionLock(definitionId) -> POST <namespace>__migration-definition-lock__definition-hash_<hash>
```

Query predicates should be used for set-oriented operations:

```txt
list item states by definition:
  value(namespace = <namespace>
    and recordKind = "migration-item-state"
    and index(definitionId = <definitionId>))

list failed item states by definition:
  value(namespace = <namespace>
    and recordKind = "migration-item-state"
    and index(definitionId = <definitionId> and status = "failed"))

list item states touched by a run:
  value(namespace = <namespace>
    and recordKind = "migration-item-state"
    and index(lastRunId = <runId>))

list locks:
  value(namespace = <namespace>
    and recordKind = "migration-definition-lock")
```

### Rollback Orphans

Source Inventory observation is stored only in the canonical Migration Item
State as the optional `lastSourceInventoryRunId` field. It is not duplicated in
the record `index` object.

`observeItemState` reads the existing Custom Object by its deterministic key.
Missing item state is a no-op. Existing state is rewritten with the current
Source Inventory run identifier using the Custom Object's current version so a
concurrent modification fails the scan before Source Cursor advancement.

`listOrphanItemStates` keeps responses bounded and deletion-safe with
`sort=key asc`, an exclusive `key > :lastKey` continuation, and
`withTotal=false`. The orphan condition queries state directly so both stale
observations and legacy states without the field are candidates:

```txt
value(namespace = :namespace)
and value(recordKind = :recordKind)
and value(index(definitionId = :definitionId))
and value(state(
  lastSourceInventoryRunId is not defined
  or lastSourceInventoryRunId != :sourceInventoryRunId
))
```

The runtime enters orphan rollback only after completing the authoritative
Source Inventory Scan. A missing or stale observation is not independently
proof that a Source Item is absent.

Item-state queries share a private page reader so the Commercetools request,
record decoding, metadata validation, and provider continuation key stay local
to one module:

```ts
interface ItemStateQueryPage {
  readonly exhausted: boolean;
  readonly lastKey?: string;
  readonly states: readonly MigrationItemState[];
}

queryItemStatePage(
  definitionId,
  predicate,
  limit
): Effect.Effect<ItemStateQueryPage, MigrationStoreError>;
```

Callers supply their completed predicate and retain their own traversal policy.
`listItemStates` scans its ordinary definition predicate to exhaustion, while
`listOrphanItemStates` uses the Source Inventory predicate and stops after its
bounded candidate page. The page reader does not combine or reinterpret those
different filters.

All query builders should avoid raw string interpolation for user-provided
values. Prefer Commercetools predicate variables if the TypeScript SDK supports
them for Custom Object queries; otherwise, centralize predicate value escaping
inside the internal client.

## Internal Modules

Suggested implementation layout:

```txt
src/migration-store/
  index.ts
  layer.ts
  options.ts
  records.ts
  keys.ts
  custom-object-client.ts
  errors.ts
```

`custom-object-client.ts` should be internal. It wraps SDK calls and exposes
store-oriented operations:

```ts
interface CommercetoolsCustomObjectClient {
  readonly get: <A>(
    key: string,
    schema: Schema.Codec<A, unknown>
  ) => Effect.Effect<A | null, MigrationStoreError>;

  readonly post: <A>(
    key: string,
    value: A,
    options?: { readonly version?: number }
  ) => Effect.Effect<void, MigrationStoreError>;

  readonly deleteByVersion: (
    key: string,
    version: number
  ) => Effect.Effect<void, MigrationStoreError>;

  readonly query: <A>(
    where: string,
    schema: Schema.Codec<A, unknown>
  ) => Effect.Effect<readonly A[], MigrationStoreError>;
}
```

Only `CommercetoolsMigrationStore` and its option types should be public.

## Testing Strategy

The first implementation should use TDD around the `MigrationStore` contract and
a fake `CommercetoolsSdk` layer.

Important tests:

- `acquireDefinitionLock` posts a lock Custom Object with `version: 0`
- concurrent modification during lock creation maps to lock acquisition failure
- `releaseDefinitionLock` checks token ownership before deleting
- cursor records round-trip through schema encoding
- all item state variants round-trip through schema encoding
- `listItemStates` filters by namespace and definition id
- key generation remains stable and bounded for long or unsafe identities
- Custom Object `null` omission does not break persisted record decoding

Integration tests against a real Commercetools project can come later behind
explicit credentials. The unit test layer should be enough to prove the runtime
contract and SDK request shapes.

## Single-Object Mode

A single-object mode is possible:

```txt
<namespace>__state
```

That object would contain all cursors, item states, run state, and locks. It
would simplify Terraform-style inspection and make compare-and-swap locking
straightforward.

It should not be the default because:

- every item update rewrites the entire state document
- one object becomes a write contention hotspot
- document size becomes the limiting factor
- sensitive or large item state becomes harder to inspect and manage

If added later, it should be an explicit compatibility or small-project mode,
not the primary storage model.

## Feasibility

This store is feasible and useful for Commercetools-first teams.

Strengths:

- state lives in the same operational system as the migrated data
- Custom Objects provide JSON storage and optimistic concurrency
- `version: 0` gives create-if-absent semantics for definition locks
- record-per-state avoids a single large state document
- the package already has a shared `CommercetoolsSdk` service layer

Risks:

- `listItemStates` may not scale indefinitely with the current core API shape
- users need Custom Object read/write scopes for the state project
- storing state in the destination project may be undesirable for
  cross-project migrations unless the store SDK layer is configurable
- force-unlock and state-inspection tooling will matter once locks are durable
- schema migration must be planned before changing record envelopes

## Example

The package includes a credential-free product catalog example at
`packages/commercetools/examples/product-catalog-store-migration.ts`.

It uses:

- `InMemorySource` for a small product catalog source fixture
- `CommercetoolsDestination` for product creation inside `process`
- `CommercetoolsMigrationStore` for Custom Object-backed cursors, item state,
  run state, and locks
- the scripted Commercetools SDK and scripted Custom Object routes from the
  package testing helpers, so the example can be typechecked and tested without
  live credentials

Run it with:

```sh
pnpm --filter @migrate-sdk/commercetools example:product-catalog-store
```

To run the same catalog migration against a real Commercetools project, provide
credentials in your shell environment or in
`packages/commercetools/examples/.env`, then run the live script:

```sh
CTP_PROJECT_KEY="your-project" \
CTP_CLIENT_ID="your-client-id" \
CTP_CLIENT_SECRET="your-client-secret" \
CTP_AUTH_URL="https://auth.<region>.commercetools.com" \
CTP_API_URL="https://api.<region>.commercetools.com" \
CTP_SCOPES="manage_project:your-project" \
pnpm --filter @migrate-sdk/commercetools example:product-catalog-store:live
```

The live script writes real Custom Objects in container `migrate-sdk-examples`
with namespace `product-catalog`, and it creates a real product with key
`effectful-architecture`. The target project must already have a `book` product
type with attributes matching the example schemas. Use a disposable project or
clean up the product and Custom Objects manually while maintenance cleanup
tooling is still future work.

The package also includes a CLI-driven live Business Unit scratchpad at
`packages/commercetools/examples/migrate.config.ts`.

It wires one real Commercetools API root into:

- `CommercetoolsSource` for loading existing Business Units
- `CommercetoolsDestination` for updating those Business Units inside
  `process`
- `CommercetoolsMigrationStore` for storing migration state in Commercetools
  Custom Objects

Edit the batch size or migration body directly in
`packages/commercetools/examples/migrate.config.ts` and
`packages/commercetools/examples/business-unit-static-field-migration.ts`. The
scratchpad loads Business Units with `CommercetoolsSource.businessUnits(...)`,
then emits a `setContactEmail` update using each Business Unit's current
`contactEmail`, so it exercises source, destination, and store wiring without a
fixture key. Credentials can stay in your shell environment or in
`packages/commercetools/examples/.env`:

```sh
pnpm --filter @migrate-sdk/commercetools example:business-units:live
```

The migration writes `setContactEmail` update actions for Business Units that
already have a `contactEmail`; Business Units without one are skipped. State is
stored in container `migrate-sdk-examples` with namespace
`business-unit-static-field`.

With the same environment loaded, inspect the plan without executing updates:

```sh
pnpm --filter @migrate-sdk/commercetools exec migrate run \
  --config examples/migrate.config.ts \
  --plan \
  business-unit-static-field
```

Future operational work should add explicit force-unlock, state export,
cleanup, and live integration-test flows. Those should be separate tools or
test suites because they have different safety and credential requirements than
the runtime store.

## External References

- Commercetools Custom Objects:
  https://docs.commercetools.com/api/projects/custom-objects
- Commercetools API limits:
  https://docs.commercetools.com/api/limits
