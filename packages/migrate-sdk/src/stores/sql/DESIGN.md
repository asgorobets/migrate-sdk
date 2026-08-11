# SQL Migration Store

`SqlMigrationStore` implements the existing `MigrationStore` service with an
application-provided Effect SQL client. The SQL Migration Store owns migration
persistence; the application continues to own the database driver, pool, and
credentials.

```ts
import { SqliteClient } from "@effect/sql-sqlite-node";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const store = SqlMigrationStore.layerFromClient(
  SqliteClient.layer({ filename: "./migration-state.sqlite" })
);
```

Use `layer()` instead when the application provides `SqlClient.SqlClient` at a
higher composition boundary:

```ts
const store = SqlMigrationStore.layer();
```

Both constructors accept:

- `tablePrefix`, which defaults to `migrate_sdk`.
- `initialize`, which defaults to `true`. Set it to `false` when schema changes
  are managed outside the SDK.

The SQL Migration Store owns seven relational tables: cursors, contracts, item
states, runs, run definitions, latest-run pointers, and definition locks. The
default names use the `migrate_sdk_` prefix.

Frequently inspected item-state fields are columns: definition, source
identity, status, last run, update time, source version, contract fingerprint,
and error tag. The complete schema-validated item state is also stored as JSON
so nested variable state can round-trip without flattening its domain model.
Status summaries only group indexed columns and do not read that JSON payload.
Full identifiers remain visible; SHA-256 surrogate keys provide fixed-width
primary and join keys across database index-size limits.

Private dialect adapters each own their schema creation, upserts, and lock
mutations. PostgreSQL and SQLite share one adapter because they use the same
`ON CONFLICT` operations; MySQL uses duplicate-key updates, and SQL Server uses
`MERGE` and `OUTPUT`. Multi-definition run transitions are transactional.
Definition locks use a database unique key for cross-process exclusion and
ownership-aware deletion.

Schema initialization supports PostgreSQL, transactional SQLite-family
clients, MySQL, and Microsoft SQL Server through the generic Effect SQL client.
Cloudflare D1 is excluded because its Effect SQL client cannot expose a
connection-scoped transaction. ClickHouse is rejected because it cannot
provide the store's transactional lifecycle and exclusive-lock guarantees.
