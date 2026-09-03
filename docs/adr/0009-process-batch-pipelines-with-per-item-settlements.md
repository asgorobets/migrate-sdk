# Process batches without making the batch the migration unit

Some destinations are much more efficient when they receive many changes at
once. We added `processBatch` so a migration can use those bulk capabilities
without giving up the per-item tracking, retries, rollback, and cursor safety
that Migrate SDK already provides.

## Status

Accepted

## Why we needed this

The normal `process` pipeline is intentionally item-oriented. The SDK reads a
window from the source, decides which items need work, processes each item, and
stores an outcome for each source identity. That is a good default: most
migrations are easiest to write and reason about one item at a time, and the
SDK can already run independent item pipelines concurrently.

Some destination APIs have a better path. Instead of asking a customer to send
50 product updates as 50 REST requests, they accept a collection of products
in one request and optimize the import on their side. That can reduce request
overhead, avoid unnecessary pressure on rate limits, and use infrastructure the
destination built specifically for large imports. The commercetools Import API
is one example, but the same shape appears in bulk indexing, bulk database
writes, and asynchronous import jobs.

There was no clean way to use such an API from `process`. Each invocation sees
one item, so coordinating a source window requires a queue or another lifecycle
outside the migration runtime. Once that happens, the SDK no longer knows when
the work for the window is complete or which destination result belongs to
which source item.

We therefore need a first-class way to hand several admitted items to the
migration at once. We do not, however, want the framework to prescribe how
those items must be handled or to turn a temporary group of items into a new
durable migration concept.

## Decision

A migration definition chooses exactly one processing style:

- `process` receives one item at a time. It remains the default when items are
  independent and the destination only needs ordinary calls.
- `processBatch` receives a non-empty window of admitted items. It is available
  when the migration needs to coordinate work across those items.

The window is the opportunity, not the instruction. A `processBatch` callback
may send every item to one bulk API, split the window into smaller requests to
respect an API limit, run several bulk requests concurrently, perform one
expensive lookup for the whole group, or inspect sibling items when that is
part of the migration's rules. The SDK has no opinion about that work.

Conversely, `processBatch` is not a general performance switch. If the
destination only exposes one-item operations and the items do not need to see
one another, `process` is clearer and already benefits from the SDK's normal
item concurrency.

### Settling the items

The batch callback is responsible for correlating the result of its work back
to every item it received. Each item exposes a `settle` function, and the
callback must return exactly one settlement for every item in the window.

Calling `settle` does not immediately mark the item as migrated, failed, or
skipped. It packages the item-level Effect that will produce that outcome. Once
the callback returns, the SDK first checks that the settlement set is complete:
no missing item, no duplicate item, and no settlement borrowed from another
batch invocation. It then runs each settlement in that item's own tracking
scope and stores the outcome against that item's source identity.

This deferred settlement is the key to the design. The migration gets enough
room to coordinate a bulk operation, while the SDK still owns the durable
boundary for every item.

### Cursor progress and retries

A `processBatch` invocation never combines separate source cursor windows. The
SDK waits until every item outcome from the current window has been stored
before it commits the next cursor.

The outcomes do not all have to be successful. If a bulk request imports 49
products and rejects one, the 49 successful items are stored as migrated and
the rejected item is stored as failed. The cursor can then advance because all
50 outcomes are durable. On the next migration run, the failed item is retried
from the backlog; the 49 successful siblings are not repeated. If the item is
still invalid, it fails again until someone corrects the source data. If the
failure was transient, the same retry path may succeed without any special
classification.

If the callback returns an invalid settlement set, the SDK cannot trust the
correlation. It executes none of the settlements and does not advance the
cursor. If the callback itself fails before returning item-level settlements,
every admitted item receives that failure because the SDK has no reliable
finer-grained outcome to persist.

### Batches are not durable state

The batch exists only while `processBatch` is running. It has no SDK-owned id,
status, retry policy, or rollback operation. Those concepts remain attached to
source items, just as they are with `process`.

This matters because a batch is usually incidental. The same 50 products may
be grouped as 20, 20, and 10 for one destination, as five groups of 10 for
another, or differently on the next run. Making one of those shapes durable
would couple migration correctness to an implementation detail and would make
one failed item drag successful siblings through retry and rollback.

Rollback therefore remains per item. Process Batch settlements use the same
journal rules as `process`: each item has its own tracking scope, and the batch
does not create a journal or attempt history of its own. Existing compensation
evidence is preserved when reprocessing fails or skips, while successful
reprocessing persists the journal produced by that successful execution.
Helper-owned journal extensions remain independent from those process entries,
so a helper may update its own durable value without replacing compensation
evidence. This extension point is available to ordinary `process` pipelines as
well; it is not batch state.

## Example: commercetools product imports

The first-party commercetools example proves this design against the Import
API. Its live catalog contains 79 products and the source exposes them in two
cursor windows: 45 and 34. Because an Import API request accepts at most 20
product drafts, the migration divides those windows into requests of
20/20/5 and 20/14, submits them with bounded concurrency, waits for the import
operations, and correlates every operation back to its product key.

The callback then returns one settlement per product. An accepted product
records its destination evidence and tracking data. A rejected product records
its failure and is eligible for the next migration run without resubmitting
its successful siblings. Only after all settlements in the source window have
finished does the SDK commit that window's cursor.

The commercetools helper stores the latest Import Operation outcome in its own
typed journal extension. Pending or ambiguously accepted operations can be read
back on a later run and polled instead of being submitted blindly. Imported and
partially imported products also record standard destination changes because
those facts may matter to compensation; the remote operation receipt itself
does not pretend to be a compensation instruction.

This commercetools example demonstrates why `processBatch` is useful; it does
not define the abstraction. Any migration may use the same capability, and the
code inside the callback remains entirely the migration author's choice.

## Consequences

- Customers can use destination bulk APIs without building a queue beside the
  migration framework or giving up per-item durability.
- Batch authors own destination limits, internal concurrency, result polling,
  and exact correlation back to source items.
- The framework can retry and roll back individual items because the physical
  batch never becomes the unit of migration state.
- External work may succeed before local settlement state is committed. Bulk
  integrations should therefore use stable identities, idempotent operations
  where available, and journal enough evidence to recover ambiguous work.
