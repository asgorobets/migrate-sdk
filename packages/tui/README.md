# Migrate TUI

Explore and operate migrations without memorizing CLI flags. For local use, the
TUI's Node Migrate Server loads the same `migrate.config.ts` as the CLI. The TUI
provides status, item counts, messages, dependency-aware execution plans, and
contextual actions for every registered migration.

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

Set `MIGRATE_SERVER_BUILD_ID` to the immutable identifier of the application
build that contains the migration configuration. A changed build ID selects a
separate local Node server endpoint; the previous endpoint keeps running until
its active Migration Runs finish. This is deployment-skew identity, not a value
to update after editing `migrate.config.ts`, and it does not reload local
source. [`ADR 0008`](../../docs/adr/0008-local-source-generations.md) defines
the separate Local Source Generation model. Without a build ID, local clients
continue to reuse the server identified by the config path and Migrate SDK
version.

Connect to a deployed Migrate Server without loading a local migration config:

```sh
pnpm exec migrate-tui --server https://migrate.example.com/api/rpc
```

When `MIGRATE_SERVER_TOKEN` is set, its value is sent as an HTTP Bearer token.
Source, destination, Migration Store,
and Execution Adapter credentials remain in the remote environment. The TUI
requires the complete Migrate Server contract, so local and remote connections
provide the same dashboard, messages, operations, source scanning, active-run
discovery, source-identity history, and run controls. Availability that depends
on a selected migration or run is reported in its data—for example, whether
rollback or stopping is supported.

Transport and server hosts can integrate directly with the Effect services
exported as `MigrateClient` from `migrate-sdk/client` and `MigrateServer` from
`migrate-sdk/server`. The local TUI supplies a child-process transport and a
Node bootstrap that discovers `migrate.config.*`. Remote hosts instead supply
an already-imported registry and execution-adapter Layer to the registry-backed
server; no config file is required.

Remote hosts can expose the same server Layer as a Web-standard HTTP handler:

```ts
import { Effect, Layer } from "effect";
import {
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  MigrateServerHttp,
  RegistryMigrateServer,
} from "migrate-sdk/server/http";

const executableLayer = /* the selected execution-adapter Layer */;
const serverLayer = RegistryMigrateServer.layer({
  environment: {
    id: "production",
    label: "Production",
  },
  registry,
}).pipe(Layer.provide(executableLayer));
const httpLayer = MigrateServerHttp.layer.pipe(Layer.provide(serverLayer));
const authorize = HttpMiddleware.make((httpApp) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) =>
      verifyMigrateRequest(request)
        ? httpApp
        : Effect.succeed(
            HttpServerResponse.text("Unauthorized", { status: 401 }),
          ),
    ),
  ),
);
const remoteServer = MigrateServerHttp.toWebHandler(httpLayer, authorize);

export const POST = (request: Request) => remoteServer.handler(request);
```

The host route owns the public URL; the Migrate Server handler is routerless
and does not need to know where it is mounted.

On a serverless or otherwise short-lived HTTP host, `executableLayer` must use a
durable Execution Adapter. An inline Execution Adapter is supported only when
the Migrate Server process remains alive for the entire run; ending that process
ends the inline execution.

Authorization is application-owned Effect HTTP middleware so deployments can
use their existing identity provider without leaving the request fiber.
Deployments where authenticated infrastructure already enforces access can omit
the middleware when converting the fully composed Layer. The HTTP transport uses
bounded observation leases: each response returns an opaque resume token and
absolute progress snapshot, and the TUI reconnects from the last token. No
function invocation or HTTP response owns the lifetime of a durable Migration
Run.

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
required dependencies, `l` to open Session activity, `R` to reload status, and
`q` to quit. When applicable, `t`
retries skipped items, `v` focuses a running migration, `x` requests a safe stop
for a run owned by the connected Migrate Server, and `u` opens
the guarded break-lock confirmation. Use
Page Up and Page Down to scroll the overview while the arrow keys continue to
select migrations. The Messages tab displays a bounded list with the current
message highlighted; use the arrow keys to move through it and `Enter` to open
the complete message and structured details. For non-interactive inspection or
export, use `migrate messages <migration>` or
`migrate messages --all --json` from the same project.

Session activity keeps the statuses, notices, warnings, and errors observed by
the current TUI session in chronological order, including active-run lifecycle
changes discovered through dashboard observation. Use the arrow keys, `j`/`k`,
Page Up and Page Down, or Home and End to navigate. Press `Enter` to read and
scroll the complete selected event, or `e` to export the retained entries as
JSON Lines without replacing an existing file. Session activity is limited to
the current TUI process; durable Migration Messages remain available through
the Messages tab and CLI after the TUI closes.

Runs start directly when their dependencies are ready. A group concurrency
override controls item processing within each migration; migration definitions
still execute in SDK plan order. If required dependencies
have not succeeded, the TUI asks whether to include them or force the selected
run. Rollback always shows the affected migrations in execution order and asks
for confirmation. While a run is active, committed cursor-window checkpoints
carry cumulative run counts and trigger targeted durable-status refreshes for
the migration that made progress.
Inline runs and runs managed by an Execution Adapter therefore update in committed batches without
scanning their sources; after an idle interval, a slower full-plan refresh
covers adapters that cannot publish checkpoints. When an execution adapter supports native observation, the
TUI also waits through its Execution Adapter identity. If that observation
channel is unavailable, the TUI reports the fallback and continues following
durable run state. Execution Adapter failure or cancellation is reconciled against
durable terminal state before it is reported. `q`, Ctrl+C, SIGINT, SIGTERM, and
SIGHUP end the current observation and close the TUI without stopping the run.
The local Node Migrate Server owns each run independently and remains available
while any run is active, so a later TUI session can reconnect by Migration Run
id. Non-overlapping migrations can run concurrently; plans that include an
already-running definition are rejected by its Migration Definition Lock. The
server exits after the final client disconnects when no run remains active. A
second Ctrl+C, or a five-second graceful-shutdown timeout, always restores the
terminal and exits.

The server discovers active runs from non-terminal durable run state whose run
id still owns a Migration Definition Lock. When that state includes an
Execution Adapter identity, View run follows the Reconnectable Migration
Run's existing checkpoints and terminal result by Migration Run id. Closing
that observation leaves the Reconnectable Migration Run active. The current
protocol can stop an inline run owned by the connected Migrate Server.
Provider-owned runs report stopping as unsupported until their Execution
Adapter implements cancellation. Break lock removes stale lock ownership but
does not cancel provider work.

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
