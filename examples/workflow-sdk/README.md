# Workflow SDK remote Migrate Server example

This Create Next App project runs PostgreSQL-backed migrations through Vercel
Workflow and exposes one authenticated Migrate Server to interactive migration
controls and the complete local Migrate TUI. The app constructs its registry
directly in TypeScript; it never discovers or loads a `migrate.config.*` file.

## What runs where

- `POST /api/migrate` is the authenticated Effect RPC Migrate Server route. The
  browser widget and external TUI use this one complete protocol. This public
  demo deliberately displays its rotating Bearer token so visitors can connect
  their own client.
- The browser widget uses `migrate-sdk/client/web` directly. It shows migration
  controls, durable checkpoint progress, browser-session activity, and durable
  migration messages without translating operations into another API.
- `GET /api/cron/import` starts the `catalog` migration group. Vercel calls it
  daily using the schedule in `vercel.json`.
- `catalogMigrationWorkflow` owns durable execution and splits each cursor
  window into Workflow SDK steps.
- PostgreSQL contains the sources seeded from the [shared checked-in Wikidata
  catalog fixture](../../fixtures/catalog/books.csv), the demo destinations,
  and the SQL Migration Store.
- The catalog intentionally includes skipped books, invalid publication years,
  and missing author references so progress and message handling remain visible.
- The local TUI is a remote client. It receives streamed dashboard snapshots
  and can reconnect using durable run data.

The cron handler calls the `MigrateServer` service directly rather than making a
loopback HTTP request. It prepares and starts the normal `catalog` group run, so
scheduled imports use the same plan validation, locks, durable Workflow SDK
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

Open <http://127.0.0.1:3100> to try the migration controls. In another terminal,
launch the complete TUI against the same Migrate Server:

```bash
MIGRATE_SERVER_TOKEN=local-migrate-secret \
  pnpm --filter @migrate-sdk/tui dev -- \
  --server http://127.0.0.1:3100/api/migrate
```

Start `authors`, `books`, or the complete `catalog` group and observe Workflow
SDK runs as they progress. The demo forces concurrency to one for browser-started
operations so checkpoint updates are easy to see.

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
3. Set `DATABASE_URL` to the pooled Neon URL. Set a random, periodically rotated
   `MIGRATE_SERVER_TOKEN` in every Vercel environment. The demo publishes this
   token to visitors so they can exercise Bearer authentication from the browser
   or their own TUI. Set separate private `DEMO_SETUP_TOKEN` and `CRON_SECRET`
   values.
4. Deploy. `withWorkflow` selects Workflow SDK's Vercel runtime automatically,
   and `vercel.json` registers the daily 05:00 UTC catalog import.
5. Initialize the demo once:

   ```bash
   curl -X POST \
     -H "Authorization: Bearer $DEMO_SETUP_TOKEN" \
     "https://YOUR_DEPLOYMENT/api/demo/setup"
   ```

6. Open the deployment to try the migration controls, or point a local TUI at
   the same server:

   ```bash
   MIGRATE_SERVER_TOKEN="TOKEN_SHOWN_ON_THE_DEMO_PAGE" \
     pnpm dlx @migrate-sdk/tui \
     --server https://YOUR_DEPLOYMENT/api/migrate
   ```

`POST /api/demo/setup?reset=true` drops all demo and migration-store data. It is
provided only for this example and remains protected by the private
`DEMO_SETUP_TOKEN`, not the visitor-facing Migrate Server token.

The page displays `MIGRATE_SERVER_TOKEN` inside the copyable TUI command. This is
intentionally easy demo access, not a production secret. For a private Migrate
Server, keep the token outside browser output and deliver it through the
client's environment or an identity-aware access layer.

Vercel invokes cron routes only for production deployments. It sends
`CRON_SECRET` as `Authorization: Bearer <secret>`; the cron route rejects calls
when that secret is absent or does not match.
