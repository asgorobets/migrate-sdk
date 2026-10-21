# First-party Files SDK integration

Status: ready-for-human

Date: 2026-10-16

Scope: implemented first-party integration; ready for review. Cloud qualification remains opt-in.

Research: [Files SDK evidence](../../docs/research/files-sdk-integration.md).
Repository baseline: `c9a2b9068a6c8229b0d4a4824813d6e0b74932e7`.

## Implementation outcome

Implemented in `packages/files-sdk` as `@migrate-sdk/files-sdk`. Public APIs,
credential-free examples, advisory storage, shared-layer lifecycle serialization,
server detach/stop coverage, package consumer smoke checks, and documentation
are included. The package reference documents the non-atomic lock limits. The
same source and helpers also have a SQL-store example. Provider-specific S3/R2
suites are present but were not run against cloud credentials. No package was
published.

The document workflow now includes `FilesSDKDocumentFetchers.texts`, sharing
file discovery and its options with `FilesSDKSource.objects`. It composes with
the generic `DocumentParsers.each(parser)` helper. Guides lead with
DocumentSource for records within a folder of files; the file Source remains
the whole-file migration option. The single-file `.text({ key })` fetcher also
remains available. This supersedes the initial single-file-only scope below.

The following sections preserve the design rationale for the implementation.

## Recommendation

Add `@migrate-sdk/files-sdk` as a first-party integration package with independent
source, destination, migration-store, and testing exports. Use the existing
`files-sdk/effect` service rather than writing another Promise-to-Effect client.
Start with object discovery, streaming transfers with journaled destination
helpers, a text fetcher for `DocumentSource`, and a JSON-record migration store.

The store's first release deliberately uses advisory definition locks and
requires one authoritative writer per namespace. This includes lifecycle and
cancellation writes, not just migration execution. Make `locking: "advisory"`
explicit in configuration and disclose the limitation at initialization. No
distributed lock service, expiry, heartbeat, or new execution engine is needed.
Source and destination users can choose an existing SQL store independently.

Native conditional locking is a useful later enhancement, not a prerequisite
for the portable integration. Files SDK has conditional primitives, but their
currently documented support does not extend to every adapter. Do not market
this proposal as lacking access to CAS altogether. See the research for the
verified provider and plugin restrictions.

## What the repository already does

| Existing boundary | Reuse for Files |
| --- | --- |
| [`Source.fromLayer`](../../packages/migrate-sdk/src/domain/definition.ts), [`SourceRuntime`](../../packages/migrate-sdk/src/services/source.ts) | Schema-backed items, identities, versions, cursor windows, direct identity lookup, optional totals, dependency provision |
| [`DocumentSource`](../../packages/migrate-sdk/src/sources/document/document-source.ts), [`DocumentFetchers`](../../packages/migrate-sdk/src/sources/document/document-fetcher.ts) | Fetch remote text and reuse parsing, selection, identity, resource fingerprint, and partial-document cursor behavior |
| [`Tracking`](../../packages/migrate-sdk/src/services/tracking.ts), [Commercetools helpers](../../packages/commercetools/src/destination/capabilities.ts) | Effect helpers that journal typed changes after a successful mutation; migration authors own Tracking Records and rollback decisions |
| [`MigrationStore`](../../packages/migrate-sdk/src/services/migration-store.ts) | Implement the complete current service, including completion, contracts, orphan observation, run history, cancellation, and locks |
| [File store](../../packages/migrate-sdk/src/stores/file/file-migration-store.ts), [Commercetools store](../../packages/commercetools/src/migration-store/index.ts) | Prior art for schema envelopes, record addresses, run projections, and nontransactional recovery; do not copy local filesystem atomicity assumptions |
| [`migrate-sdk/testing`](../../packages/migrate-sdk/src/testing.ts) | Reuse completion and superseded-run conformance scenarios, configured-source runtime helpers, and existing runtime tests |
| [Server boundary](../../docs/adr/0007-server-boundary-for-local-and-remote-clients.md) | Credentials and storage clients stay server-side; ordinary migration configuration makes the integration available to CLI/TUI |

No Files SDK dependency or integration exists at this baseline. The existing
`FileMigrationStore` means local filesystem storage, so retain that name and
introduce the distinct `FilesSDKMigrationStore` in the new package.

## Package and dependency boundary

- Create `packages/files-sdk`, published as `@migrate-sdk/files-sdk`.
- Public role subpaths: `/source`, `/destination`, `/migration-store`, `/testing`.
  Keep root exports limited to integration-owned shared public schemas/types;
  import the upstream Effect service from `files-sdk/effect` directly.
- Declare `files-sdk` with a tested compatibility range beginning at `3.1.1`,
  plus the repository's `effect` and `migrate-sdk` peer conventions. Use a Files
  peer so an application can supply its own configured client and plugin types.
  Test the minimum supported version with Effect `4.0.5` before release.
- Users construct Files clients and install only their provider's optional SDKs.
  The integration must not import every adapter or choose credentials/providers.
- Bind separate source, destination, and state layers locally. Reusing the
  upstream service tag is safe only when each role is provided separately;
  merging three layers for the same tag would silently select one backend.
- Build one shared store layer/instance for the registry's run scope. Its local
  serialization must be shared across definitions and run-control operations.
- Follow the existing conditional `dist`/types/source export map, blocked
  internal paths, and publish allow-list. Add the new package to explicit root
  package validation/build filters and docs examples.

This fits the external SDK dependency boundary established by Commercetools and
the [package export design](../../docs/design/package-export-architecture.md).

## Source: objects first, documents through composition

Proposed entry point: `FilesSDKSource.objects(options)`, returning a normal
`ConfiguredSource` that can be provided with a source-specific Files layer.

1. List one native page at a time with `prefix`, a bounded page size, and opaque
   continuation. Do not use a live iterator as durable state. The cursor schema
   stores a format version, scope fingerprint, and provider cursor; bind scope
   to an explicit stable storage id and relevant listing/version configuration.
   A cursor from another bucket, prefix, or incompatible configuration fails.
2. Emit one schema-backed object reference per item: logical key, size and
   optional ETag, numeric modification time, content type, and selected metadata.
   Keep timestamp encoding explicit at the boundary. Never put a stream, Files client, expiring
   URL, or native file handle in the source payload or durable tracking state.
3. Use the exact logical key as Source Identity within a fixed storage binding.
   Preserve case and special characters. Direct `head(key)` lookup must enforce
   the same prefix/filter rules as listing; only `NotFound` becomes `null`.
   Bind the identity-contract fingerprint to the stable storage id so pointing
   an existing migration at another bucket cannot silently reuse its item state.
   Exclude directory entries using verified adapter semantics, not a blanket
   assumption that all keys ending in `/` are directories.
4. Hydrate missing list metadata with bounded `head` requests when required.
   The default version fingerprint combines available ETag, last-modified time,
   and size in a stable schema encoding. It requires an ETag or modification
   time; otherwise require an explicit version resolver. ETags are opaque
   validators, not portable content checksums. Timestamp fingerprints can miss
   same-size changes within timestamp resolution; offer an explicit streaming
   SHA-256 resolver when stronger byte-change detection is needed. Metadata-only
   migrations should supply a version policy that covers their selected fields.
   Give version policies stable contract ids and include them in contract drift
   checks. Do not substitute a random version or the object key for a version.
5. Use full discovery. A listing token is not a modification high-water mark;
   do not expose incremental discovery for this initial source. Empty filtered
   pages with a continuation must advance; reject repeating cursor loops.
   Invalid/expired saved tokens fail with rescan guidance, preserving item state.
   The source follows native provider order; it does not promise globally
   sorted or repeatable limited-run selections. Folder-only adapters need an
   explicit later recursive traversal implementation; do not claim a prefix
   source enumerates their entire tree.
6. Leave totals unknown by default. An optional explicit full enumeration may
   supply progress totals, with the same filters, but adds request cost and is
   not authoritative snapshot evidence. Do not scan every object at startup.

Listings are not a provider-independent snapshot. Require a quiescent source
for authoritative inventory/orphan cleanup. Use disjoint source, destination,
and state prefixes (prefer separate clients/buckets); otherwise newly written
destination/state objects can enter source discovery. Validate known overlaps
in integration-owned transfer examples and document that separately configured
clients can conceal an overlap.

Add `FilesSDKDocumentFetchers.text({ key, filesLayer, maxBytes })` beside the object
source. It fetches bounded text with a content fingerprint for the existing
`DocumentSource` and `DocumentParsers.json`; it does not parse JSON itself or
claim the local-only cheap total-count capability. The first fetcher reads one
explicit object. Multi-object document traversal can follow once needed.
Remote CSV support can later factor the existing path-based CSV input boundary;
it does not justify duplicating CSV row and identity logic in this package.

## Destination helpers and transfer semantics

Proposed entry point: `FilesSDKDestination.make().provide(destinationFilesLayer)`.
Helpers require the runtime's `Tracking` service and report `DestinationError`.

| Helper | Initial behavior |
| --- | --- |
| `upload` | Upload a replayable body or body factory to a deterministic key; require an explicit write policy |
| `transferFrom` | Accept an explicitly bound source client/service and source object reference, stream download into the destination, and return durable destination facts |
| `copy` | Copy within the bound storage client; do not imply that native copy can cross arbitrary providers |
| `delete` | Explicit deletion helper with supplied precondition where supported; journal successful deletion |

The write policy is either explicit overwrite or native conditional create/
replace. Reject unsupported conditional requests; do not silently turn them
into a read-then-write check. Overwrite is the simple portable policy for an
isolated migration-owned prefix. Do not infer `created` from a preflight `head`.
Current conditional uploads reject stream bodies, so the initial streaming
transfer uses explicit overwrite. Conditional uploads use bounded replayable
bodies; large conditional transfer would require a separate staging design.
Do not add unbounded buffering to simulate a conditional stream upload.

Preserve supported content type/metadata deliberately. Unsupported requested
metadata fails by default; an explicit omit policy can record a diagnostic.
Cache-Control is not in the common source descriptor and needs a native escape
hatch when required. Destination key validity and case-folding collisions are
part of the migration's key-mapping policy; never silently rename source keys.

Record descriptors such as `files.object.uploaded`, `files.object.copied`, and
`files.object.deleted`, containing storage id, logical key, size, and available
ETag/version facts. Avoid credentials, signed URLs, bodies, raw responses, and
an invented provider-neutral version id. Migration authors still decide their
Tracking Record, for example a destination key and observed ETag.

`transferFrom` owns the stream lifetime and opens a fresh download/body for
each whole-transfer attempt. Use single-key operations for cancellation. Avoid
stacking Files retries with Effect/runtime retries. A consumed stream is not
replayable; do not reuse it on retry. When supported, use exact-read conditions
to tie downloaded bytes to the observed object. Otherwise compare available
download/head validators and fail observed changes, while disclosing the
remaining race. Optional SHA-256 verification must compare bytes under an
explicit policy; comparing ETags across providers is not verification.

Validate/checksum the stream before reporting a successful migration. A
destination object may nevertheless have committed before a source-change,
verification, journal, state-write, network, or post-commit plugin failure.
Record known applied outcomes and diagnostics where available, leave the item
failed for reconciliation, and never automatically delete that object on an
ambiguous error. Replay uses stable keys and an explicit overwrite/verification
policy. Exactly-once delivery is not claimed.

Rollback remains an explicit pipeline reading durable journal/tracking evidence.
A guarded cleanup helper may delete a tracked object with its exact ETag when
the provider supports it. Portable cleanup requires an exclusively owned prefix
and an explicit author decision; a read-then-delete ETag check cannot guarantee
ownership. V1 does not restore overwritten bytes or metadata, reverse a delete,
or automatically delete a pre-existing object. Keep move, backup/version restore,
signed uploads, multipart resume, and background event ingestion out of scope.

## Migration store: small JSON records

Proposed entry point: `FilesSDKMigrationStore.layer({ prefix, namespace, locking:
"advisory", storageId, ... })`, provided with a dedicated state Files layer.
Require a nonempty stable namespace and storage id. Keep the prefix stable;
changing its binding creates a different store.

Use one object per record, not a single growing state document:

```text
<prefix>/<namespace>/manifest.json
<prefix>/<namespace>/definitions/<definition-hash>/contract.json
<prefix>/<namespace>/definitions/<definition-hash>/cursor.json
<prefix>/<namespace>/definitions/<definition-hash>/completion.json
<prefix>/<namespace>/definitions/<definition-hash>/lock.json
<prefix>/<namespace>/definitions/<definition-hash>/latest-run.json
<prefix>/<namespace>/definitions/<definition-hash>/items/<identity-hash>.json
<prefix>/<namespace>/runs/<run-hash>.json
```

Use bounded lowercase hexadecimal hashes for arbitrary ids and a portable
lowercase namespace alphabet; retain and validate original
ids in schema-backed envelopes. Validate namespace/prefix components, format
version, record kind, storage binding, and record identity. Missing is distinct
from malformed, unauthorized, or unreadable; fail corrupt/future records rather
than reinitializing them. Encode complete core item state, including journal,
Tracking Record, failed/skip details, and inventory observation.

Implement all `MigrationStore` methods, not a checkpoint-only subset:

- Cursors, migration contracts, item states, summary, completion, and direct
  record lookup use deterministic keys and schema decoding.
- Store canonical run history plus latest-definition projections. Reuse
  `resolveMigrationRunTransition`, outcome validation, and latest-run predecessor
  guards. Replayed completion cannot overwrite terminal cancellation or a newer
  definition run. Define and test repair of partially written projections.
- Serialize conflicting read/modify/write operations within the shared process,
  including cancellation and completion. Independent records can use bounded
  concurrency. Single-writer mode still needs this protection for local fibers.
- `removeRolledBackItem` checks for an existing item, invalidates completion and
  cursor, then removes the item. Missing item is a no-op. An ambiguous remote
  delete never restores completion; it might have committed. This follows the
  conservative nontransactional rule already used by Commercetools.
- `observeItemState` updates an existing record only. List orphan states in
  Encoded Source Identity order with the service's exclusive `afterIdentity`,
  not in provider/hash-key order. Initially scan native listing pages afresh,
  decode/filter, and retain the smallest `limit + 1` qualifying identities.
  This avoids persisting an unstable listing position between deletion pages.
- `listItemStates` still returns a full collection because the core contract
  does. Compute summaries by scanning canonical records; do not introduce
  mutable counters or a second index in v1.

The state backend must provide usable read-after-write behavior, complete paged
listing, and whole-object publication for these small records in the tested
configuration. Files' capabilities are not a universal consistency or atomic
publication certificate. Do not promise every adapter is an equivalent store.
Initially validate memory (tests), local filesystem (development, no concurrent
external writers), canonical S3, and R2; expand tested support separately.
Treat all other providers as unverified for state until exercised.
The Files filesystem adapter stages the body and sidecar, then renames them
separately. Decode the JSON body as canonical state; sidecar ETags are not an
integrity authority after a crash. Neither that path nor the existing file
store's write helper establishes a power-loss/fsync guarantee in this research.

State clients should avoid stale caching, soft delete, deduplication, failover,
tiering, lifecycle expiry, and other plugins that change record visibility or
write/delete semantics. Document the tested configuration instead of attempting
to infer plugin safety from generic capability flags. Small JSON state is not
a multipart or resumable-upload use case.

### Advisory definition locks

1. Under local serialization, read the definition's lock. An existing lock
   blocks acquisition; no automatic stale timeout.
2. Write `{ definitionId, ownerRunId, token, createdAt }` with a random token.
3. Read it back; succeed only if owner and token still match.
4. Implement `getDefinitionLock` and `assertDefinitionLocks` with matching
   checks. Release reads and verifies owner/token before delete. A mismatch
   fails without intentionally deleting another owner's record.
5. Existing explicit unlock uses `breakDefinitionLock`. It removes metadata,
   not a running worker. Require the normal operator recovery flow.

The readback detects some contention; it is not mutual exclusion. For example:
both runners read absent; A writes and verifies A; B then writes and verifies B.
Both have already succeeded. Likewise, another process can replace a lock
between release's ownership check and delete. Local serialization and token
checks do not close those races or fence destination side effects.

Required disclosure in package docs, store API docs, and once per shared store
initialization through the existing logging path:

> FilesSDKMigrationStore uses advisory, non-atomic locks. Run one authoritative
> writer per namespace, including migration execution and run-control updates.
> Concurrent processes can both acquire a lock, overwrite state, or delete a
> replacement lock. Locks do not expire. Stop the original worker before
> explicitly unlocking. Use a transactional store for concurrent writers.

Multiple read-only clients through the same server are fine; source inventory
operations that write observations count as writers. Independent CLI/server
processes, overlapping local source generations with separate store instances,
or distributed workflow steps/controllers must not concurrently mutate this
store. Durable Workflow SDK support is not certified for this store in v1;
Files sources/destinations still work with Workflow SDK using an appropriate
existing store. No new CLI approval ceremony or protocol capability system is
needed for the initial disclosure.

### Cost and scale

Normal processing adds direct state reads/writes, and body transfers add source
download and destination upload requests. Listing item states and summaries is
O(N) listing plus record downloads. The simple bounded-candidate orphan scan
can rescan all N records per returned page, approaching O(N² / pageSize) work.
Document this as a modest-scale backend and expose bounded page/concurrency
options. Recommend SQL for large state inventories or frequent inspections.
Avoid one giant JSON object, persistent summary counters, or a new index until
measurements establish a need.

## Architecture decisions to record during implementation

- Follow ADR 0004's fetcher/parser split, ADR 0006's identity/tracking contracts,
  ADR 0007's server-owned clients and lifecycle behavior, ADR 0009's normal
  per-item settlements, and ADR 0011's completion invalidation order.
- The glossary currently defines a Migration Definition Lock as preventing
  concurrent execution, and ADR 0007 relies on authoritative conflict handling.
  Advisory Files locks are an explicit scoped weakening of that guarantee.
  Record a new ADR and qualify the glossary/store documentation for this
  backend; do not silently present it as an equivalent atomic implementation.
- Preserve ADR 0007's acknowledged-stop and absorbing-terminal-state guarantees
  inside the supported shared-writer topology through local serialization.
  Cross-process control remains outside the advisory store's supported scope.
- Native conditional mode can later use the actual create/replace/exact-read/
  delete flags, reconcile ambiguous commits, and use CAS on run records too.
  Atomic lock creation alone would not solve lifecycle lost updates, multi-key
  transactions, or fencing. Make this a separately tested mode, not automatic
  behavior selected solely by provider name.

## Delivery sequence and acceptance

| Order | Work | Completion evidence |
| --- | --- | --- |
| 1 | [Package and upstream Effect boundary](issues/01-package-and-effect-boundary.md) | Minimal-version types, isolated role bindings, import/package smoke tests |
| 2 | [Object source](issues/02-object-source.md) | Multi-page discovery, identity lookup, version drift, rescan and scope tests |
| 3 | [Journaled destination and streaming transfer](issues/03-destination-and-transfer.md) | Replays, consumed-stream failures, cancellation, ambiguous commits, and rollback evidence |
| 4 | [State records and lifecycle](issues/04-state-records-and-lifecycle.md) | Full store service, shared conformance, restart/failure injection, stop/completion races |
| 5 | [Advisory locking and supported topology](issues/05-advisory-locking.md) | Ownership tests, documented cross-process race demonstration, warning and recovery |
| 6 | [Document fetcher](issues/06-document-fetcher.md) | Remote JSON composes through DocumentSource and partial-resource fingerprints |
| 7 | [Examples, docs, and release](issues/07-examples-docs-release.md) | Credential-free end-to-end demo; gated S3/R2 checks; published subpath smoke tests |

Source/destination can ship before the Files store, demonstrated with an
existing store. Release the advisory store only after steps 4 and 5 pass
together. The full first-party milestone includes every row.

The end-to-end example should migrate a fixture prefix to another client,
persist state in a third binding, restart, skip unchanged objects, update a
changed object, retry a failed transfer, detach/reobserve and stop through the
same server, and perform explicit owned-prefix rollback. Add a second example
selecting records from remote JSON through `DocumentSource`. No test should
assume equal ETags across adapters or that object upload and journal/state
persistence share a transaction.

## Validation and external qualification

Implementation used `files-sdk` 3.1.1 and Effect 4.0.5. The required
`effect-solutions list` and relevant `show` guides ran through a temporary
Bun-backed CLI; installed Effect source supplied the API reference missing from
the configured clone. The Effect-enabled compiler is used for final checks.

Automated coverage includes metadata and content-hash sources, bounded remote
JSON, streaming retry/interruption, mutation evidence, all item-state outcomes,
projection and rollback failure boundaries, advisory races, shared-layer
serialization, persistent-server observation/cancellation, filesystem restart,
and a SQL-backed example. Emitted tarballs are installed in an isolated
consumer for runtime/export/declaration checks. The core regression suite and
the documentation MDX suite are also validated.

S3/R2 live tests require explicitly configured disposable storage and provider
credentials. They are excluded from normal tests. These providers remain
unqualified by this local run; no production credentials or live cloud mutations
were used. The conservative store topology and plugin restrictions apply even
when a provider's own object writes are atomic.
