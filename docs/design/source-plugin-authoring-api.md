# Source Plugin Authoring API

Audience: people implementing source plugins.

Status: source identity API updated for
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md).
This document uses the new source identity contract shape:
`SourceIdentityDefinition`, structured identity keys, and decoded
`SourceIdentityTarget` lookup input.

Source plugins emit source items by cursor and by identity. They own source
cursor semantics, source payload validation, and the declared lookup cost model.
Migration authors consume configured plugin values rather than raw Effect
services.

## Configured Source Plugin

`defineSourcePlugin` turns a source implementation into a configured source
plugin:

```ts
interface ConfiguredSourcePlugin<Source, Cursor, IdentityKey> {
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
}

interface SourcePluginInput<Source, Cursor, IdentityKey> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<Source, Cursor, IdentityKey>,
    SourcePluginError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<Source, IdentityKey> | null,
    SourcePluginError
  >;
}

interface SourcePluginImplementation<Source, Cursor, IdentityKey> {
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    SourceReadResultInput<Source, Cursor, IdentityKey>,
    SourcePluginError
  >;
  readonly readByIdentity: (
    identity: SourceIdentityTarget<IdentityKey>
  ) => Effect.Effect<
    SourceItemInput<Source, IdentityKey> | null,
    SourcePluginError
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

interface SourceItemInput<Source, IdentityKey> {
  readonly identityKey: IdentityKey;
  readonly version: SourceVersionInput;
  readonly item: Source;
}
```

Source plugins should use `identity.key`, not parse `identity.encoded`, when
implementing lookup. Source read results emit only the `IdentityKey` value; the
configured identity contract supplies the id, schema, and fingerprint, and the
runtime applies the SDK-owned canonical encoder.

The configured plugin also carries an SDK-owned source layer used by the runner.
Plugin authors normally return the configured value from `defineSourcePlugin`
instead of naming that layer type directly.

Plugins can also use the factory form when each configured plugin needs fresh
mutable state or client instances:

```ts
interface SourcePluginFactoryInput<Source, Cursor, IdentityKey> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly identity: SourceIdentityDefinition<IdentityKey>;
  readonly make: () => SourcePluginImplementation<Source, Cursor, IdentityKey>;
}
```

The runner provides the configured source layer per migration definition. Do not
register every source plugin globally under the shared `SourcePlugin` tag.

## Effect-Native API Source Plugins

`defineSourcePlugin` is already Effect-native: source reads and identity lookups
return `Effect` values, so plugin authors can compose services, layers, retries,
HTTP clients, timeouts, and bounded concurrency inside the source plugin without
a second Effect-specific factory.

The runnable `examples/api-source/` example is split by audience:

```txt
examples/api-source/
  json-placeholder-api.ts            # API service interface + live adapter
  json-placeholder-api-scripted.ts   # deterministic adapter for tests
  json-placeholder-source.ts         # source plugin factory
  migration.ts                       # migration author wiring
  format.ts                          # CLI-friendly output formatting
```

Migration authors should mostly see the migration wiring:

```ts
const destination = InMemoryDestinationPlugin.makeEntries({
  contentType: "post",
  commands: {
    publishEntry: true,
    upsertEntry: {
      fields: Schema.Struct({
        authorId: Schema.Number,
        body: Schema.String,
        title: Schema.String,
      }),
    },
  },
});

const source = JsonPlaceholderPostSourcePlugin.make();

const migration = defineMigration({
  id: "jsonplaceholder-posts",
  source,
  destination,
  store,
  pipeline: (sourceItem) =>
    destination.commands.upsertEntry({
      authorId: sourceItem.item.userId,
      body: sourceItem.item.body,
      title: sourceItem.item.title,
    }),
});
```

Plugin authors put source cursor logic and source item construction behind the
source plugin factory:

```ts
export const JsonPlaceholderPostSourcePlugin = {
  make: (options?: JsonPlaceholderPostSourceOptions) => {
    const apiLayer = options?.apiLayer ?? JsonPlaceholderApi.live();

    return defineSourcePlugin({
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
count, and detail concurrency as defaults inside the source plugin. Its public
options only expose the API layer override used by tests and live diagnostics.

`defineSourcePlugin` accepts `SourceItemInput` values and normalizes source
identity and source version into the runtime's branded values. It also normalizes
`nextCursor: undefined` away before the runtime sees the read result. Cursor
encoding and decoding still belongs to the configured `cursorSchema`.

The configured `identity` contract supplies the source identity id, schema, and
fingerprint. Each emitted `SourceItemInput.identityKey` value is the source
identity key for that item and must conform to `identity.schema`; the runtime
attaches the contract id and encoded source identity when it constructs the
pipeline-facing `SourceItem`.

The source plugin depends on a small `JsonPlaceholderApi` service with
`listPostIds()` and `getPost(id)` methods. The live adapter calls the public
JSONPlaceholder posts API through Effect's `HttpClient`, configures the base URL
and JSON accept header once, then decodes endpoint responses with
`HttpClientResponse.schemaBodyJson(...)` before returning decoded values. The API
service keeps native `HttpClientError` and `SchemaError` failures; the source
plugin maps them once to `SourcePluginError` at the SDK boundary. The scripted
adapter simulates rate limits and slow responses so plugin authors can exercise
retries, exponential backoff, request timeouts, and bounded detail-fetch
concurrency without depending on a public service to fail.

This helper does not make source plugins streamable. Source implementations may
use bounded `Effect.forEach` or other Effect composition internally, but each
runtime read still returns one cursor page. That keeps cursor commits, failed
item reruns, and durable progress semantics unchanged.

## Source Error Channel

The current source plugin contract normalizes source read and lookup failures to
`SourcePluginError`:

```ts
read(cursor): Effect.Effect<SourceReadResult<Source, Cursor>, SourcePluginError>
readByIdentity(
  identity: SourceIdentityTarget<Key>
): Effect.Effect<SourceItemInput<Source, Key> | null, SourcePluginError>
```

This keeps the runtime boundary, CLI rendering, and durable item error records
uniform across source plugins.

Open question: source plugins may eventually need typed plugin-specific error
channels before framework normalization. For example, an API source or SQL
source may want migration authors to retry transport, timeout, deadlock, or
serialization errors differently from schema, configuration, or metadata
extraction errors. A future source authoring API could preserve the native
source error type through `sourceCursorRetry` and `sourceLookupRetry`, then
normalize to `SourcePluginError` only when the runtime records or returns the
framework-level failure.

Open question: the current source schema type uses
`Schema.Codec<Source, unknown, never, never>`, which preserves the decoded
pipeline-facing type but erases the encoded/source-native input type. SQL
sources and other schema-backed sources may need the encoded side preserved so
source-owned metadata extraction can be typed from the same Source Payload
Schema that the runner uses for payload decoding.

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

Every configured source plugin must expose a Source Payload Schema:

```ts
readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
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
unchanged-terminal checks, pipeline execution, and destination command
execution. A valid source envelope with an invalid payload becomes a failed item
state with source error details.

Source plugins may decode through the schema before emitting items when that
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

The cursor schema must encode and decode the cursor shape owned by the source
plugin:

```ts
readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
```

The runner uses the cursor schema to validate stored cursor data and encode the
next cursor for storage. The migration store only sees an encoded durable cursor
string; cursor object semantics remain source-owned.

## Plugin Module Shape

A first-party source plugin should expose a narrow factory that returns a
configured source plugin. The factory can accept plugin-specific config while
hiding raw Effect service tags from migration authors. Platform-backed plugins
may accept an explicit platform layer, such as `FileSystem | Path`, instead of
importing a host runtime directly. First-party plugins live in the same
`migrate-sdk` package as the runtime unless a real platform or dependency
boundary forces a split.

```ts
export const CsvSourcePlugin = {
  make: <Source, IdentityKey>(
    options: CsvSourceOptions<Source, IdentityKey>
  ) =>
    defineSourcePlugin({
      cursorSchema: CsvSourceCursor,
      identity: makeCsvIdentityDefinition(options.identity),
      make: () => makeCsvSourceImplementation(options),
      sourceSchema: options.sourceSchema,
    }),
};
```

Source plugin modules may derive an Effect schema from source-native metadata or
require callers to pass one. Either way, the configured source plugin must carry
the final Effect `sourceSchema`.

## Error Boundary

Plugin-specific errors should be typed Effect errors, preferably with
`Schema.TaggedErrorClass` and `Schema.Defect` for unknown external causes. The
runner normalizes source errors into durable migration item error records when
they happen after a source identity is known.

Migration store failures are never source item failures. They fail the run
because the runner cannot safely continue producing destination side effects
without durable progress records.
