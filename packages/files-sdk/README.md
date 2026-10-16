# @migrate-sdk/files-sdk

Use [Files SDK](https://files-sdk.dev) storage clients with Migrate SDK. Choose
an integration based on the unit you want to migrate:

| Use case | Composition |
| --- | --- |
| Records inside structured files | `DocumentSource` + `FilesSDKDocumentFetchers` + a Document Parser and Document Selector |
| Whole files, such as assets or media | `FilesSDKSource.objects` + a Process Pipeline |
| Destination writes and rollback evidence | `FilesSDKDestination` helpers + Destination Journal entries |
| Migration state in file storage | `FilesSDKMigrationStore`, with one authoritative writer per namespace |

Each role can use a separate client and provider. Files SDK Sources and
Destinations also work with other Migration Stores, including SQL.

## Install

Requires Node.js 22.19.0+, Effect 4, and `files-sdk` 3.1.1+.

```sh
pnpm add migrate-sdk @migrate-sdk/files-sdk files-sdk effect
```

The filesystem and memory adapters need no cloud dependencies. For S3/R2,
install the optional AWS SDK packages listed in Files SDK's adapter
documentation, including `@aws-sdk/lib-storage` for streaming uploads.

## Select records from stored files

The Document Fetcher retrieves UTF-8 text, the Document Parser decodes its
format, and the Document Selector chooses the Source Items. For example, select
products from JSON files shaped as `{ "products": [{ "id": "p1" }] }`:

```ts
import {
  FilesSDKDocumentFetchers,
  type FilesSDKObjectDiscoveryOptions,
} from "@migrate-sdk/files-sdk/source";
import { Schema } from "effect";
import { Files as FilesSDKClient } from "files-sdk";
import { Files } from "files-sdk/effect";
import { fs } from "files-sdk/fs";
import { SourceIdentity } from "migrate-sdk";
import { DocumentParsers, DocumentSource } from "migrate-sdk/sources/document";

const sourceClient = new FilesSDKClient({ adapter: fs({ root: "./input-storage" }) });
const filesLayer = Files.layer(sourceClient);
const selection = {
  storageId: "legacy-catalog",
  prefix: "catalog/",
  pageSize: 20,
  filter: { id: "json-files@v1", test: (file) => file.key.endsWith(".json") },
} satisfies FilesSDKObjectDiscoveryOptions;
const CatalogDocument = Schema.Struct({
  products: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const source = DocumentSource.make({
  fetcher: FilesSDKDocumentFetchers.texts({
    ...selection,
    filesLayer,
    maxBytes: 10 * 1024 * 1024,
  }),
  parser: DocumentParsers.each(DocumentParsers.json(CatalogDocument)),
  selector: { item: (document) => document.products },
  identity: {
    id: "catalog-product@v1",
    schema: SourceIdentity.key("id", Schema.String),
    key: ({ item }) => item.id,
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
});
```

`texts` returns an array of strings for one listing page. `each(parser)` applies
the same parser to every string and combines the parsed documents in order.
It also composes with array-returning `DocumentFetchers.effect(...)` fetchers.
Empty or fully filtered pages produce zero documents and retain continuation.

DocumentSource owns record identity and versions. Identities must be unique
across all selected files; use composite identities for document-local ids.
Scan lookup reads and parses selected files to find a record by identity.
The selected product is available in a Process Pipeline as `sourceItem.item.item`.

For one known file, use `text` with the parser directly:

```ts
const fetcher = FilesSDKDocumentFetchers.text({
  key: "catalog.json",
  filesLayer,
  maxBytes: 5_000_000,
});
const parser = DocumentParsers.json(CatalogDocument);
```

Like `DocumentFetchers.fileText`, `text` returns a string; `.text` describes the
fetcher's output, while JSON decoding belongs to the parser. Both Files SDK
fetchers reject invalid UTF-8 and fingerprint downloaded bytes.

### Shared selection and paging

`FilesSDKDocumentFetchers.texts` and `FilesSDKSource.objects` accept
`FilesSDKObjectDiscoveryOptions`:

| Option | Meaning | Default |
| --- | --- | --- |
| `storageId` | Stable identity of the configured storage | Required |
| `prefix` | Literal key prefix | Empty prefix |
| `filter` | `{ id, test }`; change `id` when selection rules change | All files |
| `pageSize` | Provider listing page size, before filtering | 100 |
| `metadataConcurrency` | Concurrent metadata reads | 4 |

The folder fetcher adds `filesLayer` and `maxBytes`. Its byte bound applies to
the total downloaded bytes across selected files in one page, defaulting to
10 MiB. Bodies are read sequentially and buffered for parsing. Reduce
`pageSize` or raise `maxBytes` when a page exceeds the bound. DocumentSource's
`batchSize` separately controls windows of selected records.

If file keys or bytes change while a cursor points into a partially consumed
page, DocumentSource restarts that page. Changing storage, prefix, page size,
filter id, or byte bound requires `migrate run <definition> --rescan`. Keep
`storageId` stable for the actual storage; changing a bucket behind the same id
cannot be detected from configuration.

Listings follow provider order and folder semantics. Folder-only providers
require explicit tree traversal. Freeze source writes for authoritative orphan
cleanup and keep source, destination, and state prefixes disjoint.

## Migrate whole files

Use `FilesSDKSource.objects` when each file is one Source Item, such as copying
assets, importing media, or registering files in a destination. To migrate the
complete files selected above:

```ts
import { FilesSDKSource } from "@migrate-sdk/files-sdk/source";

const fileSource = FilesSDKSource.objects(selection).provide(filesLayer);
```

Each `sourceItem.item` is a serializable `FilesSDKObject` descriptor containing
storage id, key, size, content type, and available ETag, modification time, and
metadata. Its Process Pipeline retrieves or transfers the file's contents.
Source Identity uses the exact key; its contract is bound to `storageId`.

| Version policy | Use |
| --- | --- |
| `{ kind: "metadata" }` (default) | Fingerprint ETag, modification time, and size; fetch missing validators with `head` |
| `{ kind: "sha256" }` | Hash downloaded bytes |
| `{ kind: "custom", id, read }` | Return an Effect with a string version and `SourceError` failures; change `id` when semantics change |

Metadata versions fail when no usable validator is available. ETags are opaque
validators; timestamps can miss changes within the provider's clock resolution.
Custom policies that depend on metadata should retrieve it explicitly because
listings may omit it.

A completed discovery pass restarts on the next run, skipping unchanged
versions. Counts remain unknown without enumeration. Expired or incompatible
provider cursors require a rescan. Account for provider-specific key validity,
case sensitivity, and directory behavior when mapping destination keys.

## Bind Destination and state clients

Bind each role to its own Files layer so it uses the intended client:

```ts
import { FilesSDKDestination } from "@migrate-sdk/files-sdk/destination";
import { FilesSDKMigrationStore } from "@migrate-sdk/files-sdk/migration-store";

const destinationClient = new FilesSDKClient({ adapter: fs({ root: "./output-storage" }) });
const stateClient = new FilesSDKClient({ adapter: fs({ root: "./migration-state" }) });

const destination = FilesSDKDestination.make({ storageId: "new-assets" })
  .provide(Files.layer(destinationClient));
const store = FilesSDKMigrationStore.layerFromClient({
  client: stateClient,
  storageId: "migration-state",
  namespace: "asset-import",
  locking: "advisory",
});
```

The [complete file migration](https://github.com/asgorobets/migrate-sdk/blob/main/packages/files-sdk/examples/object-migration.ts)
connects a Source, a Process Pipeline, a Tracking Record, and a Rollback Pipeline.
It reserves `output/` exclusively for the migration and deletes journaled uploads
from that prefix during rollback. The
[SQL composition](https://github.com/asgorobets/migrate-sdk/blob/main/packages/files-sdk/examples/sql-migration.ts)
uses the same Source and Destination with SQL-backed state.

### Destination policies

| Helper | Operation |
| --- | --- |
| `upload` | Upload a buffered body or obtain a fresh body from an Effect factory |
| `transferFrom` | Stream a file from a separately supplied Files service |
| `copy` | Copy within the bound client |
| `delete` | Delete with an exact ETag or an exclusively owned prefix policy |

Uploads and copies require `write: { kind: "overwrite" }`,
`{ kind: "create" }`, or `{ kind: "replace", etag }`. Create/replace use native
provider predicates and fail when unsupported. Conditional uploads require
buffered bodies; conditional copies also require `sourceEtag`.

`transferFrom` requires overwrite and completes within one Process Pipeline
execution. Success requires end-of-stream, upload acknowledgement, size and
source-validator checks, and any requested checksum verification. Failure or
interruption fails the operation; a retry opens a fresh reader at byte zero.
`verify: "sha256"` downloads destination bytes to compare checksums, adding
bandwidth. ETags cannot be compared across providers, and validator comparisons
have a race when the source provider lacks exact reads. Choose Files SDK and
Effect retry policies together to avoid multiplying attempts.

Transfers preserve content type and custom metadata from the downloaded file.
Set `metadata: "omit"` to omit custom metadata; unsupported metadata fails.
Copying Cache-Control requires the native client because it is absent from the
common source descriptor.

### Journal and rollback

Helpers record typed Destination Journal entries under `destination.changes`.
Choose a Tracking Record for any materialized destination reference, and supply
a Rollback Pipeline for compensation.

Successful copies journal the destination's observed size and available ETag.
The [guarded copy rollback example](https://github.com/asgorobets/migrate-sdk/blob/main/packages/files-sdk/examples/copy-rollback.ts)
decodes `destination.changes.copied` and passes that ETag to
`delete({ key, policy: { kind: "exact", etag } })`. The provider checks the ETag
during deletion. A changed ETag or unsupported conditional deletion fails
rollback and retains Migration Item State.

A copy's ETag may be absent because the provider omits it or the follow-up
metadata read failed. The acknowledged copy remains journaled. Reconcile it or
choose `{ kind: "owned-prefix", prefix }` only for an exclusively owned prefix;
that policy is an author assertion of ownership.

Overwrites and deletions have no automatic restore. Aborted or rejected
requests may have committed; inspect journal evidence and reconcile uncertain
outcomes. File mutations and migration-state persistence are separate commits.

## Migration Store

> FilesSDKMigrationStore uses advisory, non-atomic locks. Run one authoritative
> writer per namespace, including migration execution and run-control updates.
> Concurrent processes can both acquire a lock, overwrite state, or delete a
> replacement lock. Locks do not expire. Stop the original worker before
> explicitly unlocking. Use a transactional store for concurrent writers.

`locking: "advisory"` is required and documents this limitation in the IDE.
The store also logs the disclosure when initialized. Share one store layer
across definitions in a registry. Multiple observers can connect to the same
persistent server; use SQL for concurrent servers or distributed execution and
control writers.

| Option | Meaning | Default |
| --- | --- | --- |
| `storageId` | Stable identity of the state storage | Required |
| `namespace` | 1–64 lowercase letters, digits, or hyphens; starts with a letter or digit | Required |
| `locking` | Must be `"advisory"` to accept non-atomic locks | Required |
| `prefix` | Lowercase state path using letters, digits, `/`, `_`, or `-`; starts with a letter or digit, without empty segments or a trailing slash | `migrate-sdk` |
| `pageSize` | State listing page size | 100 |
| `readConcurrency` | Concurrent record reads | 4 |
| `maxRecordBytes` | Maximum bytes per JSON record | 16 MiB |

`layerFromClient` binds a configured client; `layer` accepts a supplied upstream
Files service. The store validates persisted JSON and fails on malformed or
unsupported state.

Use a dedicated state client with fresh reads, complete listing, and whole-object
publication. Avoid stale caching, soft delete, versioning, deduplication,
failover, tiering, and lifecycle expiry. Filesystem body and metadata commits
are separate; no power-loss durability guarantee is provided. Memory and
filesystem have local automated coverage; qualify S3/R2 against live storage.
Summaries and orphan cleanup scan stored records repeatedly, so prefer SQL for
large inventories.

## Test an integration

```sh
pnpm --filter @migrate-sdk/files-sdk check-types
pnpm --filter @migrate-sdk/files-sdk test
```

`@migrate-sdk/files-sdk/testing` exports `makeMemoryFilesSDK`, returning a memory
adapter, client, bound Effect service, and layer for credential-free tests.

To qualify a disposable cloud bucket, install its optional SDKs, select
`FILES_LIVE_PROVIDER=s3` or `r2`, set `FILES_LIVE_BUCKET`, configure the adapter's
standard credentials, and run `pnpm --filter @migrate-sdk/files-sdk test:live`.
The suite creates a UUID prefix and deletes its objects during cleanup.
