# Source Authoring API

Audience: people implementing sources.

Status: source identity API updated for
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md).
This document uses the new source identity contract shape:
`SourceIdentityDefinition`, structured identity keys, and decoded
`SourceIdentityTarget` lookup input.

Sources emit source items by cursor and by identity. They own source
cursor semantics, source payload validation, and the declared lookup cost model.
Migration authors consume configured source values rather than raw Effect
services.

## Configured Source

`Source.make` turns a source implementation into a configured source. The
configured source is layer-backed; migration authors consume that
configured value rather than raw Effect services:

```ts
interface ConfiguredSource<
  Source,
  Cursor,
  IdentityKey,
  SourceInput = Source,
> {
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
}

interface SourceMakeInput<
  Source,
  Cursor,
  IdentityKey,
  SourceInput = Source,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
    SourceError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<SourceInput, IdentityKey> | null,
    SourceError
  >;
}

interface SourceImplementation<
  Source,
  Cursor,
  IdentityKey,
  SourceInput = Source,
> {
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<SourceInput, Cursor, IdentityKey>,
    SourceError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<SourceInput, IdentityKey> | null,
    SourceError
  >;
}
```

The runtime parses, decodes, validates, and encodes source identity targets
before calling `readByIdentity`:

```ts
interface SourceIdentityTarget<Key> {
  readonly id: SourceIdentityContractId;
  readonly key: Key;
  readonly encoded: EncodedSourceIdentity;
}

interface SourceItemInput<SourceInput, IdentityKey> {
  readonly identityKey: IdentityKey;
  readonly version: SourceVersionInput;
  readonly item: SourceInput;
}
```

Sources should use `identity.key`, not parse `identity.encoded`, when
implementing lookup. Source read results emit only the `IdentityKey` value; the
configured identity contract supplies the id, schema, and fingerprint, and the
runtime applies the SDK-owned canonical encoder.

The configured source also carries an SDK-owned source layer used by the runner.
Source authors normally return the configured value from `Source.make`
instead of naming that layer type directly.

Sources can also use the factory form when each configured source needs fresh
mutable state or client instances:

```ts
interface SourceFactoryInput<
  Source,
  Cursor,
  IdentityKey,
  SourceInput = Source,
> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly make: () => SourceImplementation<
    Source,
    Cursor,
    IdentityKey,
    SourceInput,
  >;
}
```

The runner provides the configured source layer per migration definition. Do not
register every source globally under the shared `Source` tag.

When a source already has a complete `Layer<Source, E, R>`, adapt that
layer with `Source.fromLayer` instead of adding another constructor name:

```ts
const source = Source.fromLayer({
  cursorSchema,
  identity,
  sourceSchema,
  layer: SourceLive,
});

const testSource = source.provide(SourceApi.testLayer(fixtures));
const liveSource = source.provide(SourceApi.liveLayer(config));
```

## Effect-Native API Sources

`Source.make` is already Effect-native: source reads and identity lookups
return `Effect` values, so source authors can compose services, layers, retries,
HTTP clients, timeouts, and bounded concurrency inside the source without
a second Effect-specific factory.

The runnable `examples/api-source/` example is split by audience:

```txt
examples/api-source/
  json-placeholder-api.ts            # API service interface + live adapter
  json-placeholder-api-scripted.ts   # deterministic adapter for tests
  json-placeholder-source.ts         # source factory
  migration.ts                       # migration author wiring
  format.ts                          # CLI-friendly output formatting
```

Migration authors should mostly see the migration wiring:

```ts
const destination = InMemoryDestination.makeEntries({
  contentType: "post",
  fields: Schema.Struct({
    authorId: Schema.Number,
    body: Schema.String,
    title: Schema.String,
  }),
});

const source = JsonPlaceholderPostSource.make();

const migration = MigrationDefinition.make({
  id: "jsonplaceholder-posts",
  source,
  store,
  process: (sourceItem) =>
    destination.entries.upsert({
      authorId: sourceItem.item.userId,
      body: sourceItem.item.body,
      title: sourceItem.item.title,
    }),
});
```

Source authors put source cursor logic and source item construction behind the
source factory:

```ts
export const JsonPlaceholderPostSource = {
  make: (options?: JsonPlaceholderPostSourceOptions) => {
    const apiLayer = options?.apiLayer ?? JsonPlaceholderApi.live();

    return Source.make({
      cursorSchema: JsonPlaceholderPostCursor,
      sourceSchema: JsonPlaceholderPost,
      identity: SourceIdentity.make({
        id: "jsonplaceholder-post@v1",
        schema: SourceIdentity.key("postId", Schema.NonEmptyString),
      }),
      lookupStrategy: "direct",
      read: Effect.fn("JsonPlaceholderPostSource.read")((cursor) =>
        withApiLayer(apiLayer, readPostPage(cursor))
      ),
      readByIdentity: Effect.fn("JsonPlaceholderPostSource.readByIdentity")(
        (identity) => withApiLayer(apiLayer, readPostByIdentity(identity.key))
      ),
    });
  },
};
```

The JSONPlaceholder source keeps retry policy, timeout, page size, max post
count, and detail concurrency as defaults inside the source. Its public
options only expose the API layer override used by tests and live diagnostics.

`Source.make` accepts `SourceItemInput` values and normalizes source
identity and source version into the runtime's branded values. It also normalizes
`nextCursor: undefined` away before the runtime sees the read result. Cursor
encoding and decoding still belongs to the configured `cursorSchema`.

The configured `identity` contract supplies the source identity id, schema, and
fingerprint. Each emitted `SourceItemInput.identityKey` value is the source
identity key for that item and must conform to `identity.schema`; the runtime
attaches the contract id and encoded source identity when it constructs the
pipeline-facing `SourceItem`.

The source depends on a small `JsonPlaceholderApi` service with
`listPostIds()` and `getPost(id)` methods. The live adapter calls the public
JSONPlaceholder posts API through Effect's `HttpClient`, configures the base URL
and JSON accept header once, then decodes endpoint responses with
`HttpClientResponse.schemaBodyJson(...)` before returning decoded values. The API
service keeps native `HttpClientError` and `SchemaError` failures; the source
maps them once to `SourceError` at the SDK boundary. The scripted
adapter simulates rate limits and slow responses so source authors can exercise
retries, exponential backoff, request timeouts, and bounded detail-fetch
concurrency without depending on a public service to fail.

This helper does not make sources streamable. Source implementations may
use bounded `Effect.forEach` or other Effect composition internally, but each
runtime read still returns one cursor page. That keeps cursor commits, failed
item reruns, and durable progress semantics unchanged.

## Source Error Channel

The current source contract normalizes source read and lookup failures to
`SourceError`:

```ts
read(cursor): Effect.Effect<
  SourceReadResultInput<SourceInput, Cursor, Key>,
  SourceError
>
readByIdentity(
  identity: SourceIdentityTarget<Key>
): Effect.Effect<SourceItemInput<SourceInput, Key> | null, SourceError>
```

This keeps the runtime boundary, CLI rendering, and durable item error records
uniform across sources.

Open question: sources may eventually need typed source-specific error
channels before framework normalization. For example, an API source or SQL
source may want migration authors to retry transport, timeout, deadlock, or
serialization errors differently from schema, configuration, or metadata
extraction errors. A future source authoring API could preserve the native
source error type through `sourceCursorRetry` and `sourceLookupRetry`, then
normalize to `SourceError` only when the runtime records or returns the
framework-level failure.

The core source schema type is `SourcePayloadSchema<Source, SourceInput>`, which
can preserve both the decoded pipeline-facing value and the source-native input
value emitted by the source. Source authors should preserve `SourceInput` when
the source has a stable structured input shape that its helpers inspect, such as
a SQL row. Sources may use `unknown` when the input side is intentionally opaque
or fully owned by source-specific selectors, such as CSV row parsing, Document
selection, or in-memory test items.

## Cursor Reads

`read(cursor)` reads one source cursor window and returns the next cursor when
more source items may be available.

```ts
const SqlArticleCursor = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.String,
});

const read = Effect.fn("SqlArticleSource.read")(function* (cursor) {
  const rows = yield* queryArticles({
    after: cursor,
    limit: 500,
    orderBy: ["updated_at", "id"],
  });

  const last = rows.at(-1);

  return {
    items: rows.map((row) => ({
      // Identity key value for the configured Source Identity Contract.
      identityKey: String(row.id),
      version: row.updated_at.toISOString(),
      item: row,
    })),
    nextCursor:
      last === undefined
        ? undefined
        : {
            id: String(last.id),
            updatedAt: last.updated_at.toISOString(),
          },
  };
});
```

Cursor read failures fail the migration definition run. The runner does not know
which source identities were selected, so it cannot safely record item-specific
failures for cursor discovery errors.

The next cursor is committed after a cursor window is processed, even when some
items in that window fail. Failed items are retried later from item state using
`readByIdentity`.

## Identity Lookup

`readByIdentity(identity)` receives a decoded `SourceIdentityTarget`. It powers
failed-item reruns, skipped reruns, needs-update backlog, and targeted runs.

If the source system has a direct lookup API, use it and set
`lookupStrategy: "direct"`. If it does not, implement lookup by scanning and set
`lookupStrategy: "scan"` so callers can warn about expensive reruns.

```ts
type SourceLookupStrategy = "direct" | "scan";
```

When the source identity is already known, `readByIdentity` failures can become
item failures instead of run-level discovery failures.

## Source Payload Schema

Every configured source must expose a Source Payload Schema:

```ts
readonly sourceSchema: SourcePayloadSchema<Source, SourceInput>;
```

This schema lives at the external-source boundary. It may decode source-native
values into pipeline-facing values. For example, a CSV source can decode string
fields into trimmed strings and numbers before the pipeline receives the item:

```ts
const CsvArticleSource = Schema.Struct({
  title: Schema.Trim,
  views: Schema.NumberFromString,
});
```

The runtime decodes every emitted `sourceItem.item` with `sourceSchema` before
unchanged-terminal checks, pipeline execution, and destination effect
execution. A valid source envelope with an invalid payload becomes a failed item
state with source error details.

When a source exposes a known source-native shape, use
`SourcePayloadSchema<Source, SourceInput>` so source-owned helpers can reference
the same input shape the runtime validates. For example, SQL uses the input side
for metadata extraction and `SqlIdentity.columns(...)` validation. When a source
does not expose a stable source-native item shape, `unknown` remains the right
encoded side.

Sources may decode through the schema before emitting items when that
makes implementation code safer. The runtime validation still remains the
authoritative boundary.

Rich sources do not need representation-changing decoding when their values
already have the desired pipeline-facing shape:

```ts
const JsonArticleSource = Schema.Struct({
  title: Schema.String,
  views: Schema.Number,
});
```

## Cursor Schema

The cursor schema must encode and decode the cursor shape owned by the source:

```ts
readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
```

The runner uses the cursor schema to validate stored cursor data and encode the
next cursor for storage. The migration store only sees an encoded durable cursor
string; cursor object semantics remain source-owned.

## Source Module Shape

A first-party source should expose a narrow factory that returns a
configured source. The factory can accept source-specific config while
hiding raw Effect service tags from migration authors. Platform-backed sources
may accept an explicit platform layer, such as `FileSystem | Path`, instead of
importing a host runtime directly. First-party sources live in the same
`migrate-sdk` package as the runtime unless a real platform or dependency
boundary forces a split.

```ts
export const CsvSource = {
  make: <Source, IdentityKey>(
    options: CsvSourceOptions<Source, IdentityKey>
  ) =>
    Source.make({
      cursorSchema: CsvSourceCursor,
      identity: makeCsvIdentityDefinition(options.identity),
      make: () => makeCsvSourceImplementation(options),
      sourceSchema: options.sourceSchema,
    }),
};
```

Source modules may derive an Effect schema from source-native metadata or
require callers to pass one. Either way, the configured source must carry
the final Effect `sourceSchema`.

## Error Boundary

Source-specific errors should be typed Effect errors, preferably with
`Schema.TaggedErrorClass` and `Schema.Defect` for unknown external causes. The
runner normalizes source errors into durable migration item error records when
they happen after a source identity is known.

Migration store failures are never source item failures. They fail the run
because the runner cannot safely continue producing destination side effects
without durable progress records.
