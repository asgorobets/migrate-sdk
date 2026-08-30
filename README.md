# Migrate SDK

**Migrate content from any CMS to any CMS.**

Migrate SDK is a TypeScript toolkit for moving content into, out of, or between
CMSes. Connect it to CMS APIs, databases, files, or commerce platforms. It saves
progress for each content item, so you can stop and restart a run, retry only
what failed, and roll changes back when needed.

Use it when a one-off script is no longer enough and the migration needs to run
safely more than once.

> Migrate SDK is under active development and its public API may change before
> 1.0.

## Why Migrate SDK?

- **Move more than pages.** Migrate entries, assets, references, localized
  content, and related commerce data in the order they need.
- **Catch bad input early.** Define incoming content with Effect Schema and keep
  those types while you process it.
- **Pick up where you stopped.** Saved cursors and item results let interrupted
  runs continue instead of starting over.
- **Retry only what needs attention.** Re-run failed or skipped items, update
  records you already moved, or target one item.
- **See what happened.** Preview a run, check its status, follow progress, and
  inspect errors without digging through a wall of logs.
- **Undo changes when needed.** Keep track of destination changes while the
  migration runs and use them in your rollback code.
- **Connect to any CMS API.** Write the CMS-specific calls while Migrate SDK
  handles progress, retries, status, and rollback.

## How it works

```text
Read content -> Define the move -> Process each item -> Write content
                         |
                         v
                  Save progress
          position, results, changes,
               locks, and run history
```

A **Migration Definition** says where content comes from, how each item should
be handled, and where progress should be saved. Put definitions in a
**Migration Definition Registry** when content types need to run together or in
a certain order.

## Install

```sh
pnpm add migrate-sdk effect
```

Optional packages add support for more systems:

```sh
pnpm add @migrate-sdk/commercetools
pnpm add @migrate-sdk/workflow-sdk
pnpm add --save-dev @migrate-sdk/tui
```

## From plan to recovery

Once you export your migrations from `migrate.config.ts`, the CLI gives you a
simple plan, run, check, retry, and rollback loop:

```sh
# See what will run before touching the new CMS
pnpm exec migrate run content --plan

# Run one migration and check its saved progress
pnpm exec migrate run articles
pnpm exec migrate status articles

# Retry only failed entries or target one entry
pnpm exec migrate run articles --failed
pnpm exec migrate run articles --id article-1042

# Scan from the beginning but skip entries whose source version still matches
pnpm exec migrate run articles --rescan

# Scan from the beginning and force migrated entries through process again
pnpm exec migrate run articles --update

# Preview a rollback before executing it
pnpm exec migrate rollback articles --plan
pnpm exec migrate rollback articles
```

## Full and incremental source discovery

Sources default to full discovery. Cursors let interrupted runs resume, but a
completed run clears its cursor so the next run scans from the beginning.
Existing Source Versions still keep unchanged items out of the Process
Pipeline.

Use incremental discovery only when the source has a valid high-water cursor
and every new or changed item is guaranteed to sort after it:

```ts
const source = CommercetoolsSource.products({
  discovery: "incremental",
});
```

`migrate run --plan` and `migrate status` show the resolved discovery policy.
Normal cursor-discovery runs warn when a selected source is incremental because
changes at or before its saved cursor require `--rescan` to be discovered.
Targeted failed, skipped, and item retries do not emit this warning because they
look up durable item state directly instead of traversing the source cursor.

## What is included

| Area | Included |
| --- | --- |
| Sources | SQL, CSV, structured documents, in-memory, and custom CMS or API sources |
| Saved progress | SQL, file, in-memory, and Commercetools Custom Objects |
| Destinations | Custom CMS or API services, Commercetools, and in-memory testing |
| Running migrations | In the current process or through Workflow SDK |
| Operations | Planning, progress, status, targeted runs, retries, updates, cancellation, and rollback |

## Packages

- [`migrate-sdk`](./packages/migrate-sdk) — TypeScript API, CLI, built-in data
  sources, and places to save progress.
- [`@migrate-sdk/commercetools`](./packages/commercetools) — Commercetools
  source, write helpers, and migration progress stored in Custom Objects.
- [`@migrate-sdk/workflow-sdk`](./packages/workflow-sdk) — run migrations with
  Workflow SDK.
- [`@migrate-sdk/tui`](./packages/tui) — discover, inspect, run, retry, and roll
  back registered migrations in a terminal UI. Its OpenTUI renderer runs under
  Bun while a package-supplied Node Migrate Server loads and executes local
  migration configs.

Local CLI and TUI clients reuse a Node Migrate Server for the selected config.
Built applications should set `MIGRATE_SERVER_BUILD_ID` to their immutable
build identifier. A changed value starts a new server generation for new
operations without replacing migration code underneath active runs from the
previous generation. This value identifies a packaged artifact, not an edit to
local source. Local development source revisions use supervised Node workers so
the TUI can stay connected while existing runs remain pinned to the code that
started them; see [ADR 0008](./docs/adr/0008-local-source-generations.md).

## Repository development

This repository uses pnpm and Turborepo. Node.js 24 is required.

```sh
pnpm install
pnpm build-packages
pnpm validate-packages
```

Run `pnpm dev` to start the local apps. The documentation site lives in
[`apps/docs`](./apps/docs).

## Status

Migrate SDK is used in real migration projects, but it has not reached 1.0. For
now, the focus is the core workflow: define a content migration, run it, see
what happened, retry what failed, and roll it back when needed.
