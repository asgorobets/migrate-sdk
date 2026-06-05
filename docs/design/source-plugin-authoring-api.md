# Source Plugin Authoring API

Audience: people implementing source plugins.

Source plugins emit source items by cursor and by identity. They own source
cursor semantics, source payload validation, and the declared lookup cost model.
Migration authors consume configured plugin values rather than raw Effect
services.

## Configured Source Plugin

`defineSourcePlugin` turns a source implementation into a configured source
plugin:

```ts
interface ConfiguredSourcePlugin<Source, Cursor> {
  readonly layer: Layer.Layer<AnySourcePlugin>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
}

interface SourcePluginInput<Source, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly lookupStrategy: SourceLookupStrategy;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<SourceReadResult<Source, Cursor>, SourcePluginError>;
  readonly readByIdentity: (
    identity: SourceIdentity
  ) => Effect.Effect<SourceItem<Source> | null, SourcePluginError>;
}
```

Plugins can also use the factory form when each configured plugin needs fresh
mutable state or client instances:

```ts
interface SourcePluginFactoryInput<Source, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly make: () => SourcePluginImplementation<Source, Cursor>;
}
```

The runner provides the configured source layer per migration definition. Do not
register every source plugin globally under the shared `SourcePlugin` tag.

## Cursor Reads

`read(cursor)` reads one source cursor window and returns the next cursor when
more source items may be available.

```ts
const SqlArticleCursor = Schema.Struct({
  id: Schema.String,
  updatedAt: Schema.String,
});

type SqlArticleCursor = typeof SqlArticleCursor.Type;

const read = Effect.fn("SqlArticleSource.read")(function* (
  cursor: SqlArticleCursor | null
) {
  const rows = yield* queryArticles({
    after: cursor,
    limit: 500,
    orderBy: ["updated_at", "id"],
  });

  const last = rows.at(-1);

  return {
    items: rows.map((row) => ({
      identity: String(row.id),
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

`readByIdentity(identity)` is required. It powers failed-item reruns, skipped
reruns, needs-update backlog, and single-item runs.

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

type CsvArticleSource = typeof CsvArticleSource.Type;
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

## Plugin Package Shape

A packaged source plugin should expose a narrow factory that returns a
configured source plugin. The factory can accept plugin-specific config while
hiding Effect layers and service tags from migration authors.

```ts
export const CsvSourcePlugin = {
  plugin: (options: CsvSourceOptions) =>
    defineSourcePlugin({
      cursorSchema: CsvCursor,
      sourceSchema: options.sourceSchema,
      make: () => makeCsvSourceImplementation(options),
    }),
};
```

Source plugin packages may derive an Effect schema from source-native metadata
or require callers to pass one. Either way, the configured source plugin must
carry the final Effect `sourceSchema`.

## Error Boundary

Plugin-specific errors should be typed Effect errors, preferably with
`Schema.TaggedErrorClass` and `Schema.Defect` for unknown external causes. The
runner normalizes source errors into durable migration item error records when
they happen after a source identity is known.

Migration store failures are never source item failures. They fail the run
because the runner cannot safely continue producing destination side effects
without durable progress records.
