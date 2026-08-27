# Workflow SDK remote Migrate Server example

This Create Next App project runs PostgreSQL-backed migrations through Vercel
Workflow and exposes them to a local Migrate TUI. The app constructs its
registry directly in TypeScript; it never discovers or loads a
`migrate.config.*` file.

## What runs where

- `POST /api/migrate` is the authenticated Effect RPC migration-server route.
- `GET /api/cron/import` starts the `catalog` migration group. Vercel calls it
  daily using the schedule in `vercel.json`.
- `catalogMigrationWorkflow` owns durable execution and splits each cursor
  window into Workflow SDK steps.
- PostgreSQL contains sources seeded from the [shared checked-in catalog
  fixture](../../fixtures/catalog/books.csv), the
  demo destinations, and the SQL Migration Store.
- The local TUI is a remote client. It receives streamed dashboard snapshots
  and can reconnect using the durable run data.

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
3. Set `DATABASE_URL` to the pooled Neon URL and set a long random
   `MIGRATE_SERVER_TOKEN` in every Vercel environment you use. Set a separate
   random `CRON_SECRET` for production cron requests.
4. Deploy. `withWorkflow` selects Workflow SDK's Vercel runtime automatically,
   and `vercel.json` registers the daily 05:00 UTC catalog import.
5. Initialize the demo once:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $MIGRATE_SERVER_TOKEN" \
     "https://YOUR_DEPLOYMENT/api/demo/setup"
   ```

6. Point the local TUI at the deployment:

   ```bash
   MIGRATE_SERVER_TOKEN="$MIGRATE_SERVER_TOKEN" \
     pnpm --filter @migrate-sdk/tui dev -- \
     --server https://YOUR_DEPLOYMENT/api/migrate
   ```

`POST /api/demo/setup?reset=true` drops all demo and migration-store data. It is
provided only for this example and remains protected by the same bearer token.

Vercel invokes cron routes only for production deployments. It sends
`CRON_SECRET` as `Authorization: Bearer <secret>`; the cron route rejects calls
when that secret is absent or does not match.
