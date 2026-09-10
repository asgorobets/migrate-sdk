# SQLite catalog TUI demo

This fixture provides a persistent catalog migration with real CC0 Wikidata
book metadata, deterministic scale, known failures and skips, durable SQLite
state, SQL destination writes, and reversible migrations.

Its source rows come from the [repository-local checked-in catalog
seed](../../../../fixtures/catalog/books.csv) shared with remote
execution examples.

Normal setup and execution are offline. No API key is required. The checked-in
snapshot was downloaded from the public Wikidata SPARQL endpoint.

## Set up the fixture

From the repository root:

```sh
pnpm --filter migrate-sdk demo:sqlite-catalog:setup
```

The default scale generates 10,000 books. Use `--scale small` for 500 books or
`--scale large` for 50,000 books:

```sh
pnpm --filter migrate-sdk demo:sqlite-catalog:setup -- --scale small
```

Setup refuses to replace an existing fixture. Pass `--reset` when the existing
source, migration state, and destination data should be replaced:

```sh
pnpm --filter migrate-sdk demo:sqlite-catalog:setup -- --reset
```

Reset is accepted only for a directory previously marked by this setup command.
It refuses to recursively delete an arbitrary path supplied through
`MIGRATE_SQLITE_CATALOG_DIR`.

Generated files live under `.data/` and are excluded from Git. The source
datasets remain CSV files; migration state and destination records are stored
in separate SQLite databases.

## Open the TUI

```sh
node packages/tui/bin/migrate-tui.js \
  --config packages/migrate-sdk/examples/sqlite-catalog/migrate.config.ts
```

The published command starts the package's pinned Bun renderer, which acts as a
client of a local Node Migrate Server over Effect RPC. The Node process loads
this config and runs the SDK, SQLite adapters, sources, stores, destinations,
and migration code. No global Bun installation is required, and the migration
runtime matches the Node CLI. See
[`ADR 0007`](../../../../docs/adr/0007-server-boundary-for-local-and-remote-clients.md).

The `catalog` group contains Authors, Publishers, Subjects, and Books. Books
require Authors and Publishers and optionally depend on Subjects. Run Books
without Subjects to exercise the optional-dependency decision, or run the
entire Catalog group to follow the complete hierarchy.

The default processing delay is 10 milliseconds per migrated item. Override it
without rebuilding the fixture:

```sh
MIGRATE_SQLITE_CATALOG_DELAY_MS=25 \
  node packages/tui/bin/migrate-tui.js \
  --config packages/migrate-sdk/examples/sqlite-catalog/migrate.config.ts
```

Use Concurrency settings in the TUI to compare 1, 4, 16, and Unbounded. SQLite
still serializes writes; the delay makes process-pipeline concurrency visible
without claiming linear database throughput.

## Inspect performance with OpenTelemetry

With an OTLP/HTTP JSON receiver running on the standard local port, add `--otel`:

```sh
node packages/tui/bin/migrate-tui.js --otel \
  --config packages/migrate-sdk/examples/sqlite-catalog/migrate.config.ts
```

This exports to `http://localhost:4318/v1/traces` with service name `migrate-sdk`.
For Motel, start `motel` in another terminal and override its nonstandard port:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:27686 \
  node packages/tui/bin/migrate-tui.js --otel \
  --config packages/migrate-sdk/examples/sqlite-catalog/migrate.config.ts
```

Run the Catalog group, then select `migrate-sdk` in the trace viewer. Compare
`migration.run`, `migration.source.window`, `migration.source.read`,
`migration.item.admit`, `sqliteCatalog.books.process`, and
`migration.source.cursor.commit`. This example reads 100-row CSV windows and
performs individual SQL writes; it does not use a bulk `processBatch` callback.

Compare concurrency 1, 4, and 16 with the same fixture and delay. After each
completed run, close the TUI and reset the fixture before the next comparison;
otherwise the next run encounters already-processed state. Repeat with
`MIGRATE_SQLITE_CATALOG_DELAY_MS=0` to remove the simulated wait. Failures and
skips are intentional fixture cases.

For custom service names, headers, and other settings, see the
[OpenTelemetry guide](../../../../docs/telemetry.md).

## Retry, update, and rollback scenarios

The generated Books source includes deterministic skips, missing author
references, and invalid publication years. Repair failed source rows and bump
their source versions with:

```sh
pnpm --filter migrate-sdk demo:sqlite-catalog:mutate -- repair-failures
```

Publish a deterministic set of revised titles as Source Item updates with:

```sh
pnpm --filter migrate-sdk demo:sqlite-catalog:mutate -- publish-updates
```

After repairing failures, choose **Retry failed** in the TUI. After publishing
updates, open **All actions** and choose **Update** to scan from the beginning
and process source items whose versions changed. A Source Inventory Scan checks
source membership; it does not schedule version updates.

All four migrations support rollback. Group rollback follows the reverse
dependency order so Books are removed before their referenced Authors,
Publishers, and Subjects.
