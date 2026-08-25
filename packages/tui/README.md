# Migrate TUI

Explore and operate migrations without memorizing CLI flags. The TUI loads the
same `migrate.config.ts` as the CLI and provides status, item counts, messages,
dependency-aware execution plans, and contextual actions for every registered
migration.

Install it in the migration project alongside the SDK:

```sh
pnpm add migrate-sdk effect
pnpm add --save-dev @migrate-sdk/tui
pnpm exec migrate-tui
```

The published command is a small Node launcher. It runs the renderer with the
pinned Bun runtime supplied by the package, so users do not need a global Bun
installation. The renderer starts a local Node Migrate Server and communicates
with it over Effect RPC. `migrate.config.ts`, `migrate-sdk`, migration
dependencies, stores, sources, destinations, and execution adapters all remain
in Node, matching the local CLI runtime contract. See
[`ADR 0007`](../../docs/adr/0007-server-boundary-for-local-and-remote-clients.md).

Programmatic consumers use the same client/server boundary:

```ts
import { makeMigrationTuiRuntime } from "@migrate-sdk/tui";

const runtime = await makeMigrationTuiRuntime({ cwd: process.cwd() });

try {
  const dashboard = await runtime.refresh();
  console.log(dashboard.rows);
} finally {
  await runtime.dispose?.();
}
```

The package does not expose the in-process server runtime from its public entry
point.

Transport and server hosts can integrate directly with the Effect services
exported as `MigrateClient` from `migrate-sdk/client` and `MigrateServer` from
`migrate-sdk/server`. The local TUI supplies a child-process transport and a
Node-configured migration backend for those services.

`migrate-sdk` and `effect` remain peer dependencies: the TUI and config use the
migration project's compatible versions. `@migrate-sdk/tui` and `migrate-sdk`
are published with matching versions.

For workspace development:

```sh
pnpm --filter @migrate-sdk/tui demo
```

Use an explicit project config:

```sh
pnpm --filter @migrate-sdk/tui dev -- --config ./migrate.config.ts
```

The npm package is the supported local distribution. A compiled renderer binary
remains available for packaging experiments and version smoke tests:

```sh
pnpm --filter @migrate-sdk/tui build:binary
(cd packages/tui && ./dist/binary/migrate-tui --version)
```

The renderer binary is not currently a standalone Migrate TUI distribution: a
functional release also needs the Node Migrate Server entry and the migration
project's compatible `migrate-sdk` and `effect` packages. Cross-compilation,
the companion server layout, signing gates, and OpenCode references are documented
in [`docs/research/tui-binary-distribution.md`](../../docs/research/tui-binary-distribution.md).

The footer keeps primary and contextual shortcuts visible for the current
selection. Press `Enter` to open All actions, which includes the complete action
set such as rescan, update, and Concurrency settings. Concurrency settings provides
session-scoped concurrency overrides for the Process Pipeline, Rollback Pipeline,
and Source Inventory Scan; blank values preserve the configured defaults and
Process or Rollback concurrency can be set to unbounded. Press `c` to open
Concurrency settings and `g` to switch
between migration and group tabs, `m` for errors and messages, `r` to run the selected migration or group,
`e` to run selected source identities, `f` to retry failed items, `b` to
rollback, `s` to run a Source Inventory Scan for the current selection and its
required dependencies, `R` to reload status, and `q` to quit. When applicable, `t`
retries skipped items and `u` opens the guarded break-lock confirmation. Use
Page Up and Page Down to scroll the overview while the arrow keys continue to
select migrations. The Messages tab displays a bounded list with the current
message highlighted; use the arrow keys to move through it and `Enter` to open
the complete message and structured details. For non-interactive inspection or
export, use `migrate messages <migration>` or
`migrate messages --all --json` from the same project.

Runs start directly when their dependencies are ready. A group concurrency
override controls item processing within each migration; migration definitions
still execute in SDK plan order. If required dependencies
have not succeeded, the TUI asks whether to include them or force the selected
run. Rollback always shows the affected migrations in execution order and asks
for confirmation. While a run is active, committed cursor-window checkpoints
carry cumulative run counts and trigger targeted durable-status refreshes for
the migration that made progress.
Inline and provider-backed runs therefore update in committed batches without
scanning their sources; after an idle interval, a slower full-plan refresh
covers adapters that cannot publish checkpoints. When an execution adapter supports native observation, the
TUI also waits through its provider execution identity. If that observation
channel is unavailable, the TUI reports the fallback and continues following
durable run state. Provider failure or cancellation is reconciled against
durable terminal state before it is reported. `q`, Ctrl+C,
SIGINT, SIGTERM, and SIGHUP cancel active local work and wait for it to finish
before closing. A second Ctrl+C, or a five-second graceful-shutdown timeout,
always restores the terminal and exits. Runs already handed to a background
executor continue after the TUI closes; the TUI stops observing them locally
but does not claim to cancel provider-owned work.

If React or the terminal renderer fails unexpectedly, the TUI destroys the
failed renderer, reloads durable migration state, and creates one fresh UI
session. An active execution remains owned by the runtime and the replacement
screen reattaches to its status. A second renderer failure exits normally after
restoring the terminal instead of entering a restart loop.

## Terminal regression test

[Pilotty](https://github.com/msmps/pilotty) is pinned as a development
dependency. Exercise the real PTY interaction and responsive-layout path with:

```sh
pnpm --filter @migrate-sdk/tui test:pilotty
```

The harness verifies planned retry and rollback scopes, view transitions,
cooperative cancellation and draining, the 72×34 compact dashboard, and the
120×36 confirmation views. It prints the directory that contains its text
snapshots for further inspection.

The compiled-binary smoke check builds and relocates the host executable, loads
its embedded version, and verifies it can start independently. The npm package
smoke and local IPC test cover real migration execution:

```sh
pnpm --filter @migrate-sdk/tui test:binary
pnpm --filter @migrate-sdk/tui test:ipc
```
