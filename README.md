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
- **Use bulk APIs when they fit.** Process a source window together for
  destinations that accept bulk writes while tracking, retrying, and rolling
  back every source item independently.
- **See what happened.** Preview a run, check its status, follow progress, and
  inspect errors without digging through a wall of logs.
- **Undo changes when needed.** Keep track of destination changes while the
  migration runs and use them in your rollback code.
- **Connect to any CMS API.** Write the CMS-specific calls while Migrate SDK
  handles progress, retries, status, and rollback.

## How it works

```text
Read content -> Define the move -> Process items or batches -> Write content
                         |
                         v
                    Save progress
            position, item results,
             changes, and run history
```

A **Migration Definition** says where content comes from, whether it should be
processed one item at a time or by source window, and where progress should be
saved. Put definitions in a **Migration Definition Registry** when content
types need to run together or in a certain order.

## Install

Requires Node.js **22.19.0 or newer**, including Node 24. The same minimum
applies when embedding the SDK in another Node.js application.

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

# Try the next eligible item before running a larger migration
pnpm exec migrate run articles --limit 1

# Retry only failed entries or target one entry
pnpm exec migrate run articles --failed
pnpm exec migrate run articles --id article-1042

# Scan from the beginning but skip entries whose source version still matches
pnpm exec migrate run articles --rescan

# Scan from the beginning and force migrated entries through processing again
pnpm exec migrate run articles --update

# Preview a rollback before executing it
pnpm exec migrate rollback articles --plan
pnpm exec migrate rollback articles
```

The same server-backed commands can target a remote Migrate Server without a
local migration configuration:

```sh
MIGRATE_SERVER_TOKEN=secret pnpm exec migrate \
  --server https://migrate.example.com/api/migrate \
  list
```

Remote mode supports `list`, `graph`, `status`, `messages`, `unlock`, `run`,
`rollback`, and `runs`. Migration Store schema administration remains local.

## Skip an item intentionally

Return `skipItem(reason)` from a process pipeline to save a skipped outcome.
Normal completion returns `void`; actual failures use Effect's error channel.
The SDK validates returned results, including from JavaScript configurations.
Use `Effect.asVoid` to discard a destination helper's unrelated return value.

```ts
process: Effect.fn("articles.process")(function* (source) {
  if (!source.item.publish) {
    return skipItem("Article is not published");
  }
  yield* writeArticle(source.item);
});
```

For a batch item, return `item.settle(Effect.succeed(skipItem(reason)))` as its
settlement. A nested helper's skip result must be explicitly returned by its
caller. Skipping does not undo any destination work already performed.

This replaces `return yield* skipItem(...)` and `Effect.fail(skipItem(...))`.
See [the skip-result decision](docs/adr/0010-successful-skip-results.md).

## Full and incremental source discovery

Sources default to full discovery. Cursors let interrupted runs resume, but a
completed run clears its cursor so the next run scans from the beginning.
Existing Source Versions still keep unchanged items out of processing.

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

Normal runs select eligible items in source order. Failed and needs-update items
are handled when the scan encounters them. `--limit N` caps eligible attempts
separately for each migration in the run: unchanged migrated items do not count,
while failures and skips do. Repeating `--limit 1` skips previous successful
items; an earlier failure or skip may be attempted again.

The same limit applies to every selected migration and every included dependency:

```sh
pnpm exec migrate run authors articles --limit 1
pnpm exec migrate run --group catalog --limit 1
pnpm exec migrate run --all --limit 1
pnpm exec migrate run articles --with-dependencies --limit 1
```

For example, three selected migrations can each attempt one item with `--limit 1`.
Included dependencies run first, even when their limited pass is incomplete.
A required dependency left out of the run still needs prior completion, unless
`--force` is used. Independently selected items may not reference each other;
the usual missing-reference handling applies. The limit does not cap destination
operations or reference-created stubs.

A run stopped by its limit reports `succeeded` when its attempts succeed, just
as a successful `--id` run does. Item failures still report `failed`.
It keeps the checkpoint for a partial scan and rereads any partially processed
page on the next run. Use `--rescan --limit N` to start at the beginning explicitly.
Stopping early does not establish migration completion. An earlier completion
record remains valid unless rollback invalidates it. Reaching the end records
completion even if individual items failed, following the normal run rules.
The source still controls how many items it reads per page. Limits support normal
runs, including `--rescan`; they cannot be combined with update, targeted retries,
explicit identity targets, or orphan rollback. SDK callers can pass `limit` to
the registry run request.

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
  sources, write helpers,
  [bulk Product Draft imports](./packages/commercetools/docs/import-api.md), and
  migration progress stored in Custom Objects.
- [`@migrate-sdk/workflow-sdk`](./packages/workflow-sdk) — run migrations with
  Workflow SDK.
- [`@migrate-sdk/tui`](./packages/tui) — discover, inspect, run, retry, and roll
  back registered migrations in a terminal UI. Its OpenTUI renderer runs under
  Bun while a package-supplied Node Migrate Server loads and executes local
  migration configs.

Local CLI and TUI clients reuse a Node Migrate Server for the selected config.
Built applications should set `MIGRATE_SERVER_BUILD_ID` to their immutable
build identifier. A changed value selects a separate local server endpoint for
new operations without replacing migration code underneath active runs on the
previous endpoint. This value identifies a packaged artifact, not an edit to
local source. [ADR 0008](./docs/adr/0008-local-source-generations.md) defines
the separate Local Source Generation model.

## Repository development

This repository uses pnpm and Turborepo, with Node.js 22 as the development
default (`.nvmrc`). Node.js 22.19.0 is the minimum supported version. Release
validation checks that minimum; platform checks use the latest Node 22 release.

```sh
pnpm install
pnpm build-packages
pnpm validate-packages
```

Run `pnpm dev` to start the local apps. The documentation site lives in
[`apps/docs`](./apps/docs).

To inspect scanning, batch processing, and wait times, follow the
[OpenTelemetry exporter configuration and tracing guide](./docs/telemetry.md).

## Status

Migrate SDK is used in real migration projects, but it has not reached 1.0. For
now, the focus is the core workflow: define a content migration, run it, see
what happened, retry what failed, and roll it back when needed.
