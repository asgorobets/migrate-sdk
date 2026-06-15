# SQL Source Plugin Design

Status: draft

Audience: maintainers and migration authors working on `SqlSourcePlugin`.

## Goals

- Read source items from migration-author SQL queries.
- Use Effect SQL `SqlClient` as the database boundary instead of an SDK-owned driver abstraction.
- Keep raw SQL sources schema-backed by requiring explicit source payload and cursor schemas.
- Support limit/keyset-style cursor windows for resumable reads.
- Support direct identity lookup through a configured lookup query.
- Keep source-specific internals local to this source folder until destination reuse is real.

## Non-Goals

- Inferring TypeScript row shapes from arbitrary SQL text.
- Inferring schemas from table metadata.
- Owning database pools, connection strings, or concrete database drivers.
- Making raw SQL queries typed through Drizzle. Drizzle-backed sources should be a separate source plugin.
- Supporting SQL destination writes in this slice.

## Current Implementation

The current implementation provides the public source folder, package exports,
a named plugin surface, and the read/lookup happy path:

```ts
SqlSourcePlugin.name; // "sql"
SqlSourcePlugin.make({
  batchSize,
  cursorSchema,
  getSourceMetadata,
  identity,
  lookup,
  read,
  sourceSchema,
});
```

The configured source layer requires `SqlClient.SqlClient` unless the migration
author closes that requirement with `source.provide(sqlClientLayer)`. `read`
and `readByIdentity` execute configured statement builders, convert rows into
Source Item inputs through metadata extraction, and normalize SQL execution
failures into the current `SourcePluginError` boundary.

The implementation validates cursor-window configuration and the source-item
contract at the SQL boundary:

- `batchSize` must be a positive integer before a read statement is built.
- Read rows must produce Source Identity, Source Version, and Source Cursor
  metadata.
- Duplicate Source Identities in one read window fail that read after normal
  Source Identity input normalization.
- Direct lookup must return zero or one row, and a returned row's metadata
  identity must match the requested Source Identity.

The test suite includes a local SQLite-style table-backed client that exercises
keyset pagination over multiple read windows and direct lookup without `OFFSET`
or `LIMIT 1`.

## Target Public API

The target raw SQL source exposes an Effect SQL `SqlClient` layer requirement
and accepts explicit query callbacks:

```ts
const source = SqlSourcePlugin.make({
  batchSize: 500,
  cursorSchema: LegacyArticleCursor,
  identity: LegacyArticleIdentity,
  sourceSchema: LegacyArticleSource,
  read: (sql, cursor, limit) =>
    sql`
      select id, updated_at, title, body
      from legacy_articles
      where ${cursor === null ? sql`true` : sql`(updated_at, id) > (${cursor.updatedAt}, ${cursor.id})`}
      order by updated_at asc, id asc
      limit ${limit}
    `,
  getSourceMetadata: (row, context) =>
    ({
      kind: "success",
      identityKey: row.id,
      version: row.updated_at,
      cursor: {
        updatedAt: row.updated_at,
        id: row.id,
      },
    }),
  lookup: (sql, identity) =>
    sql`
      select id, updated_at, title, body
      from legacy_articles
      where id = ${identity.key}
    `,
});

const definition = defineMigration({
  id: "legacy-articles",
  source,
  destination,
  pipeline,
  store,
});

yield* runMigration(definition).pipe(Effect.provide(pgClientLayer));
```

If a migration config should own a specific SQL connection, close the source
requirement on the configured plugin instead:

```ts
const legacySource = SqlSourcePlugin.make({
  batchSize: 500,
  cursorSchema: LegacyArticleCursor,
  identity: LegacyArticleIdentity,
  sourceSchema: LegacyArticleSource,
  read: legacyRead,
  lookup: legacyLookup,
  getSourceMetadata: legacyMetadata,
}).provide(legacyPgClientLayer);

const crmSource = SqlSourcePlugin.make({
  batchSize: 500,
  cursorSchema: CrmUserCursor,
  identity: CrmUserIdentity,
  sourceSchema: CrmUserSource,
  read: crmRead,
  lookup: crmLookup,
  getSourceMetadata: crmMetadata,
}).provide(crmPgClientLayer);
```

After `.provide(...)`, the SQL client requirement is erased from that source
plugin and does not leak into the migration, registry, CLI, or runner types.
Leaving the source unprovided intentionally exposes the requirement so editors
and applications can provide one shared app layer at the runner boundary.

The important shape is that migration authors supply queries and schemas; the
SDK supplies the source plugin lifecycle, cursor persistence,
row-to-source-item mapping, and error mapping.

Raw SQL v1 requires exactly one public payload schema: `sourceSchema`. Any
Effect SQL row decoding must be an internal implementation detail or a helper
owned by the SQL source API. It must not become a second required user-facing
schema option.

The SQL row type should come from the encoded/input side of `sourceSchema`.
Conceptually:

```ts
interface SqlSourceOptions<Row, Source, Cursor, IdentityKey> {
  readonly sourceSchema: Schema.Codec<Source, Row, never, never>;
  readonly getSourceMetadata: (
    row: Readonly<Row>,
    context: SqlSourceMetadataContext
  ) => Result<SqlSourceMetadata<Cursor, IdentityKey>, SqlSourceMetadataError>;
}

interface SqlSourceMetadata<Cursor, IdentityKey> {
  readonly identityKey: IdentityKey;
  readonly version: SourceVersionInput;
  readonly cursor: Cursor;
}

interface SqlSourceMetadataError {
  readonly message: string;
  readonly cause?: unknown;
}
```

Migration authors should not need a separate public row schema or manually
duplicated row type when `sourceSchema` already describes the row entering the
framework. If metadata columns should not be visible to the pipeline, the
Source Payload Schema can decode from a wider SQL row into a narrower
pipeline-facing item.

The current core source contract erases the encoded side as `unknown`:
`Schema.Codec<Source, unknown, never, never>`. Preserving the source payload
input type is a framework refinement, not a reason for the raw SQL source to add
a second required schema.

Read and lookup callbacks are declarative statement builders, not arbitrary
Effect programs. `SqlSourcePlugin` owns statement execution so it can preserve
consistent source diagnostics, SQL error mapping, lookup cardinality checks,
source metadata extraction, and cursor advancement.

`SqlClient.SqlClient` is required by the configured SQL source layer until the
source plugin itself is provided. The SQL source must not resolve an ambient or
global SQL client in v1, and it must not own connection pools. Applications can
provide the SQL client layer at the runner or app composition boundary when
several migrations should share one database pool, or call
`source.provide(sqlClientLayer)` when a specific migration source should carry
its own SQL client dependency.

## Source Row Contract

Raw query rows are external data. The SQL source plugin wraps each row in a
Source Item input, but Source Payload Schema decoding remains owned by the
migration runner. This keeps SQL aligned with CSV, JSON, API, and other source
plugins: a source item with a valid identity and version but an invalid payload
becomes a failed Migration Item State instead of a cursor-read failure.

The plugin should require a pure source metadata extractor that returns a
Result-style value with:

- `identityKey`: the source identity key value that matches the configured
  Source Identity contract.
- `version`: the durable Source Version input.
- `cursor`: the next cursor candidate for pagination.

`SqlSourcePlugin` should pass metadata values through the existing source item
normalization boundary. It should not require authors to construct branded
`SourceIdentity` or `SourceVersion` values directly.

The extractor receives the SQL row as a read-only value and a small page-local
context:

```ts
interface SqlSourceMetadataContext {
  readonly rowIndex: number;
}
```

`rowIndex` is for diagnostics only. The context should not include an operation
flag, Effect services, or the current input cursor. Metadata extraction should
not behave differently for read and lookup rows. Expected metadata extraction
failures should be returned as Result errors rather than thrown exceptions.
The exact Result implementation is an implementation choice for the SQL source
slice; the public design requirement is explicit success/error return values
instead of exception-driven control flow.

The source item payload is the SQL row returned by the statement. Raw SQL v1
does not expose a separate payload mapper. This keeps the SQL source from
becoming a transformation pipeline. If a migration needs a different payload
shape, the author should express that with SQL projection or the Source Payload
Schema. Effectful enrichment belongs in the Transformation Pipeline, not in SQL
source row handling. The SQL source treats returned row objects as read-only.

The raw SQL source should not derive identity or version automatically from
column names. SQL exports vary too much, and the mapping is migration-specific.

If Effect SQL offers useful schema-backed row decoding internally, the SQL
source may use it as an implementation detail. That must not add a second
user-facing schema requirement, and it must not change the framework boundary:
the configured Source Payload Schema is still the public contract the runner
uses before invoking the transformation pipeline.

`read` and `readByIdentity` are two access paths to the same Source Item
contract. Raw SQL v1 should therefore use one source metadata extractor for
both read and lookup results. The SQL projections may include extra fields, but
they must be compatible with the same extractor and produce the same
`identityKey`, `version`, payload, and cursor semantics for a given source item.

## Cursor Contract

The raw SQL source should use keyset-style cursors as the default guidance:
the cursor represents the last successfully emitted ordering key, not a numeric
offset. Offset pagination can skip or duplicate rows when source data changes
during a run.

Cursor shape is migration-specific, so authors provide `cursorSchema`. For
example, a cursor might be `{ updatedAt: string, id: string }`, while another
source may use `{ id: number }`.

Source Version and Source Cursor may share fields, but they are different
signals: version is for change detection, cursor is for ordering and resume.

Each row's source metadata includes the cursor that resumes after that row. The
cursor is required for every returned row. The source plugin computes
`nextCursor` from the last emitted row's cursor. An empty window should not
advance the cursor.

If source metadata extraction cannot produce a cursor for a read row, the
cursor read fails as a source plugin failure. SQL v1 should not support
non-advancing pages that return items.

SQL v1 should not issue `limit + 1` probes to prove more rows exist. Any
non-empty read result returns `nextCursor` from the last row. An empty read
result terminates cursor discovery.

Raw SQL v1 should require `batchSize` as the public source option for the
number of Source Items in one Source Cursor Window. It must be a positive
integer. The read statement builder receives that value as `limit`, because
`LIMIT` is the SQL mechanism for applying the configured batch size. The SDK
cannot safely rewrite arbitrary SQL, so the read statement must apply the
provided `limit`.

`offset` should not be a first-class v1 API concept. Source position is carried
by the Source Cursor, normally as a keyset cursor such as `{ updatedAt, id }`.

## Ordering Contract

The read statement must apply deterministic ordering compatible with the cursor
returned by `getSourceMetadata`. Cursor fields should include a stable
tie-breaker, usually the source identity, so rows with the same primary ordering
value do not get skipped or duplicated.

Good keyset pagination:

```ts
const ArticleCursor = Schema.Struct({
  updatedAt: Schema.String,
  id: Schema.String,
});

SqlSourcePlugin.make({
  batchSize: 500,
  cursorSchema: ArticleCursor,
  identity: ArticleIdentity,
  sourceSchema: ArticleSource,
  read: (sql, cursor, limit) =>
    sql`
      select id, updated_at, title, body
      from legacy_articles
      where ${
        cursor === null
          ? sql`true`
          : sql`(updated_at, id) > (${cursor.updatedAt}, ${cursor.id})`
      }
      order by updated_at asc, id asc
      limit ${limit}
    `,
  lookup: (sql, identity) =>
    sql`
      select id, updated_at, title, body
      from legacy_articles
      where id = ${identity.key}
    `,
  getSourceMetadata: (row) =>
    ({
      kind: "success",
      identityKey: row.id,
      version: row.updated_at,
      cursor: {
        updatedAt: row.updated_at,
        id: row.id,
      },
    }),
});
```

Avoid offset pagination for durable migration progress:

```ts
read: (sql, _cursor, limit) =>
  sql`
    select id, updated_at, title, body
    from legacy_articles
    order by updated_at asc
    limit ${limit}
    offset 500
  `;
```

That query does not use the Source Cursor, hard-codes position outside durable
cursor state, and lacks a stable tie-breaker for rows with the same
`updated_at`.

## Lookup Contract

Raw SQL v1 requires direct lookup. The migration runtime uses `readByIdentity`
to recover source items for dependency stubs, failed-item reruns, skipped
reruns, needs-update backlog, update checks, and single-item runs, so the SQL
source requires a lookup statement builder.

`SqlSourcePlugin` should declare `lookupStrategy: "direct"` internally and
should not expose scan lookup in v1. If a source cannot address a Source Item by
Source Identity, it is not a good fit for durable SQL source reruns yet.

Lookup queries must identify at most one Source Item. Multiple returned rows for
one Source Identity should be a source plugin failure because it makes
dependency lookup ambiguous. The SQL source should fail when the executed
lookup statement actually returns more than one row; it should not try to
rewrite arbitrary SQL to enforce uniqueness.

The lookup callback should return a SQL statement. It should not perform the
lookup effect itself.

Lookup results use the same source metadata extractor as cursor-read results.
This keeps failed-item reruns, skipped reruns, needs-update backlog, and
single-item runs observing the same Source Item shape as normal cursor
discovery. The extractor still returns a cursor for lookup rows, but
`readByIdentity` ignores that cursor because identity lookup does not advance
source position.

After metadata extraction, lookup must verify that the extracted Source Identity
matches the requested identity after normal Source Identity input
normalization. A mismatch is a source plugin failure because the lookup
statement returned the wrong Source Item.

Cursor reads should reject duplicate Source Identities within one returned
window after metadata extraction and normal Source Identity input
normalization. Duplicate detection across different windows is out of scope for
the SQL source plugin; deterministic SQL ordering and durable item state handle
the broader migration behavior.

Metadata extraction failures during cursor reads fail the cursor read because
the runtime may not have a valid Source Identity for the bad row. Metadata
extraction failures during lookup fail that lookup and may become an item
failure because the requested Source Identity is already known. Payload schema
failures remain item-level failures because they occur after identity and
version are available.

## Effect SQL Boundary

The source plugin should depend on the generic `SqlClient` service from Effect
SQL, not on `pg`, `mysql2`, SQLite clients, or SDK-owned driver interfaces.
Applications provide concrete layers such as a Postgres layer, and the plugin
runs query callbacks in that Effect environment.

There are two supported provision boundaries:

- App-level provision: keep `SqlClient.SqlClient` in the source requirement and
  provide a shared app layer to `runMigration`, `runMigrations`, or the
  registry runner.
- Source-level provision: call `source.provide(sqlClientLayer)` so that the
  configured source owns that SQL client layer and the migration no longer
  requires `SqlClient.SqlClient`.

Source-level provision is the configuration shape for CLIs or registries where
different migration definitions need different SQL clients with the same
Effect service tag. App-level provision remains the right shape when the
application wants one memoized database pool shared by multiple definitions.

That boundary buys us:

- Tagged-template SQL construction and parameter binding.
- Database-specific statement compilation through the selected Effect driver.
- Connection acquisition and scoped resource management.
- Transactions and connection reservation when a future explicit source option
  needs them.
- Typed SQL errors that can be mapped to `SourcePluginError`.
- A path to share SQL infrastructure with a future SQL destination without
  coupling the first source slice to destination semantics.

`SqlClient` does not infer row types from raw SQL text. The source plugin still
requires explicit `sourceSchema`, `cursorSchema`, and row mapping.

Raw SQL v1 should not wrap reads or lookups in SQL transactions automatically.
Each operation executes its configured statement normally. Consistent snapshot
or transaction semantics should be a future explicit option, not a default
source behavior.

## Internal Layout

```txt
packages/migrate-sdk/src/sources/sql/
  DESIGN.md
  index.ts
  sql-source.ts
  internal/
    errors.ts
```

`internal/` is private through the package export map. If SQL source and SQL
destination eventually share substantial code, the shared module can move to a
broader internal location with a real call site proving the need.

## Target Call Stack

```txt
Migration runtime
  -> SourcePlugin.read(cursor)
    -> SqlSourcePlugin implementation
      -> acquire SqlClient from source-provided or app-provided layer
      -> execute author read query
      -> extract Source Identity, Source Version, and cursor from each row
      -> use each row as the source item payload
      -> return SourceReadResult with nextCursor

Migration runtime
  -> SourcePlugin.readByIdentity(identity)
    -> SqlSourcePlugin implementation
      -> acquire SqlClient from source-provided or app-provided layer
      -> execute author lookup query
      -> validate zero-or-one row
      -> extract Source Identity and Source Version from the row
      -> use the row as the source item payload
      -> return SourceItem or null
```

## Open Questions

No open questions for the v1 raw SQL source API direction are currently
recorded.
