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
- `initialize`, which defaults to `true`. It installs a brand-new database but
  never upgrades an existing schema. Set it to `false` to require a separately
  installed schema even on first use.

Schema version 1 is bundled with the package and executed by Effect SQL
Migrator. Its history is stored in `${tablePrefix}_schema_migrations`. Ordinary
store construction is deliberately conservative:

- an empty database is installed automatically when `initialize` is enabled;
- a current schema is opened without mutation; and
- an older, future, divergent, partial, or untracked schema is rejected.

Applications can inspect and explicitly apply a schema plan through the same
TypeScript API used by store construction:

```ts
import { Effect } from "effect";

const program = Effect.gen(function* () {
  const plan = yield* SqlMigrationStore.planSchema();

  if (plan.status === "not-installed" || plan.status === "upgrade-required") {
    yield* SqlMigrationStore.applySchemaPlan(plan);
  }
}).pipe(Effect.provide(SqliteClient.layer({ filename: "./state.sqlite" })));
```

`planSchema` is read-only. `applySchemaPlan` rechecks the plan identifier before
running anything, executes only bundled numbered migrations, and performs a
schema-shape postflight. A changed plan or a non-current postflight fails closed.
The serializable plan includes the database, installed and target versions,
pending migrations, detected issues, and database-specific warnings.
Effect SQL Migrator does not store checksums or support down migrations, so
published migration 1 must remain immutable and later changes must use higher
migration numbers.

The CLI requires an explicit SQL target because a registry can contain several
definitions backed by different stores. Configure the client layer and matching
table prefix in `migrate.config.ts`:

```ts
import { SqliteClient } from "@effect/sql-sqlite-node";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

export default defineMigrationCliConfig({
  registry,
  sqlStore: {
    clientLayer: SqliteClient.layer({ filename: "./migration-state.sqlite" }),
    tablePrefix: "migrate_sdk",
  },
});
```

Inspecting the schema does not run migrations:

```sh
migrate store schema status
migrate store schema status --json
```

Interactive upgrades show the plan and ask for confirmation, defaulting to no.
Non-interactive callers must first obtain the current plan ID and then approve
that exact plan:

```sh
plan_id=$(migrate store schema status --json | jq -r .planId)
migrate store schema upgrade --accept-plan "$plan_id"
```

`upgrade` rechecks the plan before applying it. A stale or mismatched plan ID is
rejected without changing the schema. Already-current schemas are a successful
no-op.

The SQL Migration Store owns seven state tables: cursors, contracts, item
states, runs, run definitions, latest-run pointers, and definition locks, plus
the schema-history table. The default names use the `migrate_sdk_` prefix.

Frequently inspected item-state fields are columns: definition, source
identity, status, last run, update time, source version, contract fingerprint,
and error tag. The complete schema-validated item state is also stored as JSON
so nested variable state can round-trip without flattening its domain model.
Status summaries only group indexed columns and do not read that JSON payload.
Full identifiers remain visible; SHA-256 surrogate keys provide fixed-width
primary and join keys across database index-size limits.

The numbered schema migration delegates its DDL to private vendor helpers.
Runtime dialect adapters own upserts and lock mutations. PostgreSQL and SQLite
share one adapter because they use the same `ON CONFLICT` operations; MySQL uses
duplicate-key updates, and SQL Server uses `MERGE` and `OUTPUT`.
Multi-definition run transitions are transactional. Definition locks use a
database unique key for cross-process exclusion and ownership-aware deletion.

Schema migration supports PostgreSQL, transactional SQLite-family
clients, MySQL, and Microsoft SQL Server through the generic Effect SQL client.
Cloudflare D1 is excluded because its Effect SQL client cannot expose a
connection-scoped transaction. ClickHouse is rejected because it cannot
provide the store's transactional lifecycle and exclusive-lock guarantees.
