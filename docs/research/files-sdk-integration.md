# Files SDK integration constraints

Reviewed 2026-10-16 against Files SDK 3.1.1 documentation and source. This note
collects upstream API and adapter constraints. For composition and operational
requirements, see the [package reference](../../packages/files-sdk/README.md).

## Compatibility baseline

Files SDK 3.1.1, released October 14, 2026 at commit `30e56c4`, includes the
Effect v4 bridge and fixes for interrupted buffered downloads and conditional
read error flags. The integration requires this version or newer.
[3.1.1 release](https://github.com/haydenbleasel/files-sdk/releases/tag/files-sdk@3.1.1),
[Effect bridge release](https://files-sdk.dev/changelog/files-sdk-3-1-0).

The ESM package exports `files-sdk/effect` with Effect `^4.0.0` as an optional
peer. Provider SDKs are optional peers selected through adapter subpaths.
Migrate SDK requires Node.js 22.19.0+ and catalogs Effect 4.0.5.
[Upstream manifest](https://github.com/haydenbleasel/files-sdk/blob/30e56c4/packages/files-sdk/package.json),
[local catalog](../../pnpm-workspace.yaml), [local manifest](../../package.json).

## File descriptors and body lifetime

`FileInfo` contains `key`, `size`, `contentType`, optional `etag`, optional
`lastModified` as epoch milliseconds, and optional string-to-string `metadata`.
`head` and `list` return metadata; `download` retrieves a `StoredFile` with body
accessors. `Body` supports strings, blobs, buffers, typed arrays, and web
`ReadableStream<Uint8Array>`. A streamed body is consumed once.
[Core types](https://github.com/haydenbleasel/files-sdk/blob/30e56c4/packages/files-sdk/src/index.ts),
[StoredFile](https://files-sdk.dev/docs/api/stored-file).

The integration uses serializable descriptors as Source Items. A Process
Pipeline opens the body when needed, and each transfer attempt opens a fresh
reader. This keeps consumed streams and configured clients out of durable state.

## Effect composition

`files-sdk/effect` exports the `Files` service, `FilesService`, and `make(client)`.
`Files.layer(clientOrOptions)` binds a configured client. Single-key operations
return Effects; `listAll` and `search` return Streams. A downloaded file exposes
Effect body accessors, an Effect Stream, and its underlying SDK `StoredFile`.
[Effect integration](https://files-sdk.dev/docs/integrations/effect),
[bridge source](https://github.com/haydenbleasel/files-sdk/blob/30e56c4/packages/files-sdk/src/effect/index.ts).

Failures carry a tagged reason and fields including `permanent`, `aborted`,
`timedOut`, `applied`, and `appliedEtag`. Single-key operations merge the fiber
signal with an explicit signal; bulk operations do not receive the fiber
signal. Reusing this bridge preserves upstream cancellation and error semantics.
Bind each integration role locally: merging several `Files` layers into one
context would select one implementation of the same service tag.

## Listing and Source Discovery

`list({ prefix, cursor, limit })` returns a page of `FileInfo` values, an optional
cursor, and optional common prefixes. `limit` is a page size. The common API
provides no total count or portable guarantee of sort order, cursor lifetime,
snapshot consistency, or safe mutation during traversal.
[Listing API](https://files-sdk.dev/docs/api/list).

Box, OneDrive, and SharePoint list one folder without recursion. Dropbox lists
recursively by default and can return a page with no prefix matches while
continuation remains. Filesystem listing sorts current keys and resumes after
the previous last key; new keys inserted before that position can be missed.
These provider differences require explicit traversal and cleanup policies.
[Dropbox adapter](https://files-sdk.dev/docs/adapters/dropbox),
[filesystem source](https://github.com/haydenbleasel/files-sdk/blob/30e56c4/packages/files-sdk/src/fs/index.ts).

The integration uses Full Source Discovery with opaque provider cursors.
Authoritative orphan cleanup requires a stable source inventory. A completed
listing pass alone cannot establish a snapshot of concurrently changing files.

## Conditional operations and lock limits

Capabilities report native create, replace, exact-read, and delete predicates,
with separate copy predicates. Unsupported predicates fail rather than being
emulated with a read followed by an unconditional write.
[Capabilities](https://files-sdk.dev/docs/capabilities).

Upload accepts `{ type: "create" }` or `{ type: "replace", etag }`; conditional
uploads return a new ETag. Conditions exclude bulk, multipart, resumable, and
signed upload paths. Conditional S3 uploads reject stream bodies. Single-key
deletion accepts `{ etag }`.
[Upload](https://files-sdk.dev/docs/api/upload),
[delete](https://files-sdk.dev/docs/api/delete).

Documented native support is canonical AWS S3 through the AWS SDK adapter;
custom endpoints do not inherit that guarantee. R2 and filesystem lack these
predicates. Soft delete rejects conditional deletion, versioning rejects
conditional writes/copies, and deduplication, failover, and tiering reject
conditional modes. ETags are opaque validators rather than portable checksums.
[Conditional operations](https://files-sdk.dev/docs/conditional-operations).

The portable Migration Store therefore requires one authoritative writer per
namespace and explicit `locking: "advisory"`. Read/write/read acquisition and
ownership checks on release detect some contention but cannot provide mutual
exclusion: two processes can acquire a lock or delete a replacement lock.
The same limit covers execution, cancellation, control writes, and cleanup.
Native lock creation alone would not make multi-record state transitions
transactional or prevent a stale worker from writing to a Destination.

## Retry and mutation uncertainty

Files SDK retries transient provider errors, excluding permanent errors, aborts,
timeouts, and deterministic codes. Consumed upload streams cannot be retried.
SDK retries and Effect retries multiply when both are enabled.
[Retries](https://files-sdk.dev/docs/retries).

Abort stops waiting at the SDK layer, but provider cancellation depends on the
adapter. A request may commit after the caller stops waiting, and a lost response
or plugin failure can obscure an applied mutation.
[Cancellation](https://files-sdk.dev/docs/cancellations),
[conditional operation errors](https://files-sdk.dev/docs/conditional-operations).

Destination helpers journal acknowledged and known-applied changes. Uncertain
outcomes require reconciliation. Transfers run to completion within one Process
Pipeline execution and restart at byte zero on retry. File writes and Migration
Store writes are separate commits.

## Metadata and key mapping

Provider prefixes are prepended on input and stripped on output. Stable storage
ids distinguish the configured backing stores from their relative file keys.
[Prefixes](https://files-sdk.dev/docs/prefixes).

Filesystem reserves `.meta.json`, `.fls-part`, and `.fls-tmp` leaf suffixes and
normalizes paths through the OS. Dropbox paths are case-insensitive. Key mapping
must account for the target provider's naming rules and collisions.
[Filesystem source](https://github.com/haydenbleasel/files-sdk/blob/30e56c4/packages/files-sdk/src/fs/index.ts),
[Dropbox path semantics](https://www.dropbox.com/developers/paper-api-alpha).

Metadata and Cache-Control writes fail when unsupported. The common file
metadata does not expose Cache-Control, so preserving it requires the native
client. Cross-provider byte verification uses an application checksum such as
SHA-256. These constraints also appear in Files SDK's migration guide.
[Upload options](https://files-sdk.dev/docs/api/upload),
[S3-to-R2 guide](https://files-sdk.dev/guides/migrate-s3-to-r2).

## State backend requirements

Filesystem upload stages body and metadata sidecar in temporary files and
renames them sequentially under a process-local lock. A crash between renames
can leave body and sidecar out of sync; the path has no fsync guarantee. The
Migration Store treats validated JSON bodies as canonical state.
[Filesystem publication](https://github.com/haydenbleasel/files-sdk/blob/30e56c4/packages/files-sdk/src/fs/index.ts).

State storage requires fresh reads, complete listing, and whole-object
publication. Use a dedicated client without stale caching, soft delete,
versioning, deduplication, failover, tiering, or expiry. Source and Destination
compatibility does not establish that an adapter satisfies these requirements.
Qualify cloud stores with live contract tests; memory and filesystem tests
cover only their local behavior.
