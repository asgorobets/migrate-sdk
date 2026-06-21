# Effect SQL Client for SQL Sources

## Status

Accepted

## Considered Options

- Build an SDK-owned SQL driver abstraction.
- Accept concrete database clients such as `pg` or `mysql2` directly.
- Use Effect SQL `SqlClient` as the source database boundary.
- Make raw SQL source typing depend on Drizzle.

## Decision

Raw SQL sources will use Effect SQL `SqlClient` as their database
boundary.

The SDK will not own connection pools, database drivers, placeholder syntax,
statement compilation, transaction SQL, or driver-specific error
classification. Applications will provide concrete Effect SQL layers, and the
SQL source will consume the generic `SqlClient` service through Effect.

Raw SQL source queries remain untyped from the SQL text. Migration authors must
provide an explicit source payload schema, cursor schema, row-to-source-item
mapping, and identity lookup query. A future Drizzle-backed source can use
Drizzle's table/query typing, but that should be a separate source rather
than hidden inside the raw SQL source.

Effect SQL schema-backed row decoding may be used internally, but it does not
replace the configured Source Payload Schema and does not introduce a second
required user-facing row schema for raw SQL sources.

Raw SQL source query callbacks return SQL statements for the source to execute.
They do not return arbitrary Effect programs. This keeps execution policy,
operation diagnostics, SQL error mapping, lookup cardinality checks, row
metadata extraction, and cursor advancement inside `SqlSource`.

Raw SQL v1 requires a lookup statement builder and uses direct source lookup
internally. It does not expose scan lookup because SQL reruns and single-item
mode need identity-addressable source items, not potentially unbounded cursor
discovery scans.

Raw SQL source reads and lookups are not wrapped in SQL transactions by default.
Transaction or consistent-snapshot behavior should be added only as an explicit
future source option.

The first implementation lives under
`packages/migrate-sdk/src/sources/sql/`. Source-specific internals stay in that
folder until there is a real SQL destination or shared SQL module that needs
them.

## Consequences

- The SDK avoids inventing and maintaining its own SQL driver API.
- SQL source configuration composes with Effect layers and the rest of the SDK's
  Effect runtime model.
- Concrete database support follows Effect SQL driver availability instead of
  first-party SDK driver work.
- Query construction can use Effect SQL tagged templates, parameter binding,
  dialect compilation, connection reservation, and transaction support.
- SQL failures can be translated from Effect SQL errors into `SourceError`
  without losing the original cause.
- Raw SQL source payloads stay schema-backed at the migration boundary, but row
  types are not inferred from arbitrary SQL.
- If Effect SQL import paths or stability labels change, the blast radius should
  stay inside the SQL source implementation and its internal helpers.
