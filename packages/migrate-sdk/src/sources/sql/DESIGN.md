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

## Current Scaffold

The current implementation creates the public source folder, package exports,
and a named plugin surface:

```ts
SqlSourcePlugin.name; // "sql"
SqlSourcePlugin.make({
  cursorSchema,
  sourceSchema,
});
```

`read` and `readByIdentity` intentionally fail with `SourcePluginError` until
the query contract lands. The scaffold keeps only the stable decisions in code:
this is a first-party source plugin, it is part of the main SDK package, its
source payload schema is explicit, and its cursor schema is source-specific.

## Target Public API

The target raw SQL source should accept an Effect SQL client layer and explicit
query callbacks:

```ts
const source = SqlSourcePlugin.make({
  client: pgClientLayer,
  cursorSchema: LegacyArticleCursor,
  sourceSchema: LegacyArticleSource,
  read: ({ cursor, sql }) =>
    sql`
      select id, updated_at, title, body
      from legacy_articles
      where ${cursor === null ? sql`true` : sql`(updated_at, id) > (${cursor.updatedAt}, ${cursor.id})`}
      order by updated_at asc, id asc
      limit ${500}
    `,
  mapRow: (row) => ({
    identity: row.id,
    version: row.updated_at,
    item: row,
    cursor: {
      updatedAt: row.updated_at,
      id: row.id,
    },
  }),
  lookup: ({ identity, sql }) =>
    sql`
      select id, updated_at, title, body
      from legacy_articles
      where id = ${identity}
      limit 1
    `,
});
```

The API above is a design target, not the implemented scaffold. The important
shape is that migration authors supply queries and schemas; the SDK supplies the
source plugin lifecycle, cursor persistence, row decoding, and error mapping.

## Source Row Contract

Raw query rows are external data. The source plugin must decode the `item`
portion through `sourceSchema` before the pipeline sees it. The plugin should
also require each row mapping to produce:

- `identity`: the durable Source Identity.
- `version`: the durable Source Version.
- `item`: the raw row payload decoded by `sourceSchema`.
- `cursor`: the next cursor candidate for pagination.

The raw SQL source should not derive identity or version automatically from
column names. SQL exports vary too much, and the mapping is migration-specific.

## Cursor Contract

The raw SQL source should use keyset-style cursors as the default guidance:
the cursor represents the last successfully emitted ordering key, not a numeric
offset. Offset pagination can skip or duplicate rows when source data changes
during a run.

Cursor shape is migration-specific, so authors provide `cursorSchema`. For
example, a cursor might be `{ updatedAt: string, id: string }`, while another
source may use `{ id: number }`.

The source plugin should compute `nextCursor` from the last emitted source item.
An empty window should not advance the cursor.

## Lookup Contract

The raw SQL source should prefer direct lookup. The migration runtime uses
`readByIdentity` to recover source items for dependency stubs and update checks,
so the SQL source should require a lookup query unless a future explicit
`lookupStrategy: "scan"` escape hatch is added.

Lookup queries must return zero or one row. Multiple rows for one Source
Identity should be a source plugin failure because it makes dependency lookup
ambiguous.

## Effect SQL Boundary

The source plugin should depend on the generic `SqlClient` service from Effect
SQL, not on `pg`, `mysql2`, SQLite clients, or SDK-owned driver interfaces.
Applications provide concrete layers such as a Postgres layer, and the plugin
runs query callbacks in that Effect environment.

That boundary buys us:

- Tagged-template SQL construction and parameter binding.
- Database-specific statement compilation through the selected Effect driver.
- Connection acquisition and scoped resource management.
- Transactions and connection reservation when a future source needs them.
- Typed SQL errors that can be mapped to `SourcePluginError`.
- A path to share SQL infrastructure with a future SQL destination without
  coupling the first source slice to destination semantics.

`SqlClient` does not infer row types from raw SQL text. The source plugin still
requires explicit `sourceSchema`, `cursorSchema`, and row mapping.

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
      -> acquire SqlClient from configured layer
      -> execute author read query
      -> map rows to SourceItem inputs and cursor candidates
      -> decode item payloads with sourceSchema
      -> return SourceReadResult with nextCursor

Migration runtime
  -> SourcePlugin.readByIdentity(identity)
    -> SqlSourcePlugin implementation
      -> acquire SqlClient from configured layer
      -> execute author lookup query
      -> validate zero-or-one row
      -> map and decode row
      -> return SourceItem or null
```

## Open Questions

- Whether `mapRow` should receive a row index inside the current page for
  diagnostics only.
- Whether query callbacks should return Effect SQL statements directly or an
  SDK wrapper that can attach operation metadata.
- Whether scan lookup should be supported in v1 or kept unavailable until a
  source proves it is necessary.
