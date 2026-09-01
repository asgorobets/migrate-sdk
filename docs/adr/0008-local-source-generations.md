# Local Source Generations

Local development must pick up migration source changes without changing the
behavior of a Migration Run that has already started. This requires a different
identity and lifecycle from an immutable application build.

## Status

Accepted; implementation pending

## Context

`MIGRATE_SERVER_BUILD_ID` identifies an immutable built artifact. It is useful
when two packaged versions of an application can be present at the same time,
but it is not a development revision. Editing `migrate.config.ts` or one of its
imports does not build an artifact and should not require the customer to mint
a new build id or restart the TUI.

Reloading customer modules inside the process that owns an active migration is
not safe. Migrate SDK does not own a compiler module graph, and a Migration Run
may remain active much longer than a web request. Replacing a definition,
dependency graph, or concurrency setting in place could give one run behavior
from two different source revisions.

Next.js keeps these concerns separate. Its development build identity remains
stable while its development runtime tracks source revisions, and changes that
require a clean runtime are loaded by a supervised replacement process. Vercel
Skew Protection instead keeps immutable production deployments available and
routes work to the deployment that owns it. The detailed comparison is captured
in [Next.js development HMR and Vercel Skew Protection](../research/nextjs-dev-hmr-and-vercel-skew-protection.md).

## Decision

The local Node connection will use a stable **Local Migrate Supervisor**. The
supervisor owns the public local IPC endpoint and manages immutable **Local
Source Generations**. Each generation is a Node Migrate Server worker that
loads and validates one revision of the customer's migration configuration.
The Bun TUI remains a client of the stable supervisor and never loads customer
migration modules.

There is no local build step in this lifecycle:

1. The supervisor detects a relevant source change.
2. It starts a candidate Node worker with a fresh module cache.
3. The candidate loads the config, builds its Layers, and validates its
   registry.
4. The supervisor atomically makes the candidate current only after startup
   succeeds.
5. New registry reads, plans, and starts use the current generation.
6. Runs already started remain owned by their original generation.
7. An old generation exits after all of its owned runs finish.
8. If a candidate fails to load, the last-known-good generation remains current
   and the reload failure is reported to connected clients.

The supervisor presents one logical Migrate Server. Its routing rules are:

| Operation | Route |
| --- | --- |
| Registry, migration catalog status, messages, source reads, and planning | Current generation |
| Start | Current generation, with normal plan-fingerprint validation |
| Observe, stop, and focused run progress | Generation that owns the Migration Run id |
| Active-run catalog | Union of generation-owned active-run projections, deduplicated by Migration Run id |
| Dashboard | Current migration catalog rows plus the active-run catalog; the two projections need not come from the same generation |

If source changes between `PrepareOperation` and `StartOperation`, the current
generation plans the original request again. A changed plan fingerprint is
rejected through the existing protocol instead of starting work from a stale
confirmation.

The Local Migrate Supervisor, its workers, source watching, and generation
routing are Node connection-host concerns. They do not enter the runtime-neutral
Migrate Protocol or the core SDK. Remote Migrate Servers use the same protocol,
but their deployment platform is responsible for immutable deployment routing
and source rollout.

### Local development control

The stable local IPC connection exposes two separate interfaces:

- the complete `MigrateClient`, whose operations and schemas are identical for
  local and remote Migrate Servers; and
- Node-only local development control for reloading source and observing Local
  Source Generation lifecycle events.

The development control is part of the local Migrate Connection host, not an
optional Migrate Server capability. It may use a separate local-only Effect RPC
group on the same IPC transport, but it is not part of the versioned Migrate
Protocol and is never required from an HTTPS or SSH server.

The control interface provides one reload operation and a lifecycle event
stream. Both automatic source watching and an explicit TUI reload action invoke
the same reload operation. Its events distinguish:

- a candidate generation beginning to load;
- a candidate becoming the current Local Source Generation; and
- a candidate failing, with an operator-facing diagnostic while the previous
  generation remains current.

After an activation event, the TUI invalidates registry-derived client state
and restarts its dashboard observation through the unchanged `MigrateClient`.
The TUI records activation or failure in its activity history. It does not
restart, replace its Migrate Connection, or infer successful reload from a file
event alone.

### Cross-generation dashboard ownership

The migration catalog and active-run catalog are separate read models. Migration
catalog rows describe only the current Local Source Generation. The supervisor
must not overwrite one of those rows with status read through an older
generation, even when an active run from that generation uses the same Migration
Definition Id.

For every locally started run, the supervisor retains an internal association
between its Migration Run Id and owning Local Source Generation. The active-run
catalog is the union of those generation-owned projections. Its public entries
remain normal `MigrateActiveRun` values; generation identity is connection-host
routing state and does not enter the Migrate Protocol.

The TUI renders active runs independently from migration catalog rows:

- a matching current migration row may indicate that it participates in the
  run, but its catalog status remains the current generation's status;
- selecting the run obtains its progress and terminal state from `ObserveRun`,
  routed to the owning generation; and
- a run whose Migration Definition was removed from the current registry
  remains visible in the active-run catalog by its stored definition ids until
  it becomes terminal.

This separation also covers a source edit that changes a Migration Store or
other runtime Layer. Current catalog inspection uses the new Layer, while the
old run view continues to use its owning generation. The supervisor never
pretends that state from those two environments is one migration status.

## Identity model

The following identities remain distinct:

| Identity | Meaning | Lifetime |
| --- | --- | --- |
| Migrate Protocol version | Wire compatibility | SDK release policy |
| Migrate SDK version | Published implementation identity and local endpoint compatibility | Published package version |
| Migrate Server Build Id | Immutable packaged or deployed artifact | One artifact |
| Local Source Generation | Successfully loaded local source revision | One Node worker |
| Migration Definition Registry Id | Identity of the registered migration catalog | Registry definition |
| Migration Run id | Durable execution identity and routing key | One run and its history |

The local endpoint identity continues to include the optional build id. Source
generation does not participate in that endpoint identity because the stable
supervisor must remain reachable while generations change.

## Source change detection

Source watching is an adapter behind the Local Migrate Supervisor. The preferred
watch set is the config file plus the local modules imported while loading it.
Migrate SDK must not claim compiler-grade HMR unless its Node loader can report
that module graph. A broader project-source watcher may be used as a documented
fallback, but generated output, dependencies, migration data, and Migration
Store files must not trigger reloads.

An explicit reload operation uses the same generation transition and remains
available even when automatic watching is disabled or cannot determine the
complete import graph.

## Consequences

- Editing migration B while migration A runs can load B into a new generation;
  A continues with the code and concurrency it started with.
- Closing or recovering the TUI does not own worker lifetime. A later TUI can
  reconnect to the supervisor and observe or stop a run by its Migration Run
  id.
- A failed edit does not take a healthy local server offline.
- Old generations consume resources while their runs drain, so the supervisor
  must expose their state and clean them up deterministically.
- Built artifacts still use `MIGRATE_SERVER_BUILD_ID` for version skew. Local
  source edits do not change that value.
