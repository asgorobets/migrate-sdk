# Workflow SDK remote Migrate Server example

This Create Next App project runs PostgreSQL-backed migrations through Vercel
Workflow and exposes them to both a local Migrate TUI and the real TUI rendered
in a browser. The app constructs its registry directly in TypeScript; it never
discovers or loads a `migrate.config.*` file.

## What runs where

- `POST /api/migrate` is the authenticated Effect RPC migration-server route.
- `POST /api/demo/terminal` gets or creates a shared Vercel Sandbox from a
  prepared TUI snapshot and returns a new PTY connection.
- `PATCH /api/demo/terminal` extends the active sandbox under a PostgreSQL
  advisory lease, bounded by idle and absolute lifetime limits.
- wterm renders terminal cells in the browser with the libghostty WASM core.
- `GET /api/cron/import` starts the `catalog` migration group. Vercel calls it
  daily using the schedule in `vercel.json`.
- `catalogMigrationWorkflow` owns durable execution and splits each cursor
  window into Workflow SDK steps.
- PostgreSQL contains sources seeded from the [shared checked-in catalog
  fixture](../../fixtures/catalog/books.csv), the
  demo destinations, and the SQL Migration Store.
- The local TUI is a remote client. It receives streamed dashboard snapshots
  and can reconnect using the durable run data.
- The browser TUI is the same OpenTUI process running under Bun in a disposable
  Linux microVM. It starts automatically, and the Next.js function is not kept
  alive while it runs.

The cron handler calls the `MigrateServer` service directly rather than making
a loopback HTTP request. It prepares and starts the normal `catalog` group run,
so scheduled imports use the same plan validation, locks, durable Workflow SDK
execution, and remote observation path as TUI-started imports.

The app uses workspace dependencies because the Migrate SDK packages are not
published yet.

## Run locally

From this directory:

```bash
cp .env.example .env.local
pnpm db:up
pnpm db:setup -- --reset
pnpm dev
```

In a second terminal, launch the TUI:

```bash
MIGRATE_SERVER_TOKEN=local-migrate-secret \
  pnpm --filter @migrate-sdk/tui dev -- \
  --server http://127.0.0.1:3100/api/migrate
```

Start `authors`, `books`, or the complete `catalog` group from the TUI and
observe the Workflow SDK runs as they progress.

Stop PostgreSQL with `pnpm db:down`.

To invoke the scheduled import locally:

```bash
curl \
  -H "Authorization: Bearer local-cron-secret" \
  http://127.0.0.1:3100/api/cron/import
```

## Deploy to Vercel and Neon

1. Create a Neon PostgreSQL database and copy its pooled connection string.
2. Create a Vercel project for this repository with the root directory set to
   `examples/workflow-sdk`.
3. Link this directory to the Vercel project and create the browser TUI
   snapshot. The command clones `main` by default; set
   `MIGRATE_TUI_REPOSITORY_REVISION` to build another branch or commit.

   ```bash
   vercel link
   vercel env pull
   pnpm sandbox:snapshot
   ```

4. Set `DATABASE_URL` to the pooled Neon URL and set a long random
   `MIGRATE_SERVER_TOKEN` in every Vercel environment you use. Set a separate
   random `CRON_SECRET` for production cron requests. Set
   `MIGRATE_TUI_SANDBOX_SNAPSHOT_ID` to the value printed by the snapshot
   command, and set `MIGRATE_SERVER_PUBLIC_URL` to the deployment's HTTPS
   `/api/migrate` URL.
5. Deploy. `withWorkflow` selects Workflow SDK's Vercel runtime automatically,
   and `vercel.json` registers the daily 05:00 UTC catalog import.
6. Initialize the demo once:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $MIGRATE_SERVER_TOKEN" \
     "https://YOUR_DEPLOYMENT/api/demo/setup"
   ```

7. Open the deployment to launch the browser TUI, or point a local TUI at the
   same server:

   ```bash
   MIGRATE_SERVER_TOKEN="$MIGRATE_SERVER_TOKEN" \
     pnpm --filter @migrate-sdk/tui dev -- \
     --server https://YOUR_DEPLOYMENT/api/migrate
   ```

`POST /api/demo/setup?reset=true` drops all demo and migration-store data. It is
provided only for this example and remains protected by the same bearer token.

All browser visitors share one named, one-vCPU sandbox. Each visitor receives a
separate PTY that immediately starts its own TUI process, so terminal input and
rendering remain independent while the machine and demo migration state are
shared.

While a terminal is connected, visible, and has received visitor input within
the last three minutes, the browser sends a heartbeat every 30 seconds. The
server uses a PostgreSQL advisory lock so concurrent visitors extend the shared
deadline only once, keeping the sandbox alive for two minutes after the latest
accepted heartbeat. An inactive terminal displays a confirmation before it
stops heartbeating. Every VM session has an absolute 30-minute lifetime; the
next visitor resumes a fresh session from the snapshot after it expires.

The sandbox contains no Vercel, database, or source-control credentials. Its
network policy permits only this deployment's `/api/migrate` route and injects
`MIGRATE_SERVER_TOKEN` at that boundary. The browser receives no shell prompt,
although a visitor can still alter the PTY startup frame using developer tools.
That tradeoff is intentional for this disposable public playground.

Set `MIGRATE_SERVER_PUBLIC_URL` to the application-owned HTTPS URL of the
Migrate Server route. The browser-terminal endpoint never derives this
credential-injection boundary from an incoming request URL.

Vercel invokes cron routes only for production deployments. It sends
`CRON_SECRET` as `Authorization: Bearer <secret>`; the cron route rejects calls
when that secret is absent or does not match.
