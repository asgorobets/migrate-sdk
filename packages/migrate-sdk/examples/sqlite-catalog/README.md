# SQLite catalog TUI demo

This fixture provides a persistent catalog migration with real CC0 Wikidata
book metadata, deterministic scale, known failures and skips, durable SQLite
state, SQL destination writes, and reversible migrations.

Normal setup and execution are offline. No API key is required. The checked-in
snapshot was downloaded from the public Wikidata SPARQL endpoint and can be
refreshed separately when provenance should be updated.

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
pnpm --filter @migrate-sdk/tui exec bun src/bin.tsx \
  --config ../migrate-sdk/examples/sqlite-catalog/migrate.config.ts
```

This demo config currently uses `@effect/sql-sqlite-bun` because the TUI loads
the config in its Bun renderer process. The package supplies Bun; no global Bun
installation is required. The Node CLI cannot load this particular demo config.
That temporary TUI limitation will be removed by the local Migrate Server
boundary described in
[`ADR 0007`](../../../../docs/adr/0007-server-boundary-for-local-and-remote-clients.md),
where Node loads local project configs and the TUI acts as a client.

The `catalog` group contains Authors, Publishers, Subjects, and Books. Books
require Authors and Publishers and optionally depend on Subjects. Run Books
without Subjects to exercise the optional-dependency decision, or run the
entire Catalog group to follow the complete hierarchy.

The default processing delay is 10 milliseconds per migrated item. Override it
without rebuilding the fixture:

```sh
MIGRATE_SQLITE_CATALOG_DELAY_MS=25 \
  pnpm --filter @migrate-sdk/tui exec bun src/bin.tsx \
  --config ../migrate-sdk/examples/sqlite-catalog/migrate.config.ts
```

Use Concurrency settings in the TUI to compare 1, 4, 16, and Unbounded. SQLite
still serializes writes; the delay makes process-pipeline concurrency visible
without claiming linear database throughput.

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

## Refresh the Wikidata snapshot

The public endpoint does not require an API key:

```sh
pnpm --filter migrate-sdk demo:sqlite-catalog:fetch
```

After refreshing, update `provenance.json` with the new retrieval date, record
count, query SHA-256, and snapshot SHA-256. Acquisition is intentionally
separate from setup so demos remain reproducible and do not depend on network
availability.
