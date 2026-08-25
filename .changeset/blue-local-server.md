---
"migrate-sdk": minor
"@migrate-sdk/tui": minor
"@migrate-sdk/commercetools": patch
---

Add a versioned, schema-backed Migrate Protocol with Effect RPC handlers for
dashboard discovery, messages, planning, execution, streaming observation,
cancellation of work owned by the current Migrate Server process, source scans,
source identity history, and lock recovery. Detached run cancellation by
Migration Run id remains deferred until Execution Adapters expose
provider-neutral cancellation.

Run local migration configurations in a Node Migrate Server child process while
the OpenTUI renderer remains in Bun. The npm launcher passes its exact Node
executable to the renderer, plans are revalidated by fingerprint before
execution, and live progress is multiplexed over child-process IPC. The public
programmatic runtime uses the same boundary, and the Node server reports
bootstrap failures through a nonzero process exit. Runtime-neutral
`MigrateClient` and `MigrateServer` Effect services expose constructors and
Layers for alternative transports and server deployments.

Discover active runs from durable run and lock ownership, and observe a
Reconnectable Migration Run by Migration Run id after the original client
observation or Migrate Server instance is gone. The TUI offers Attach to run for
matching locked migrations, follows committed progress, and can end the new
observation without cancelling work owned by its Execution Adapter.

Advance the Migrate Protocol to version 2 for active-run discovery and
run-based observation. Dashboard snapshots include active runs so the TUI reads
durable status once per refresh. Reconnection preserves failed terminal states
and observes through a Migration Definition Lock still owned by the run.
Migration Stores retain Migration Run State by Migration Run id when a later run
replaces a definition's latest state. Non-transactional stores commit that
authoritative run record before latest-definition projections, and retries
repair interrupted projection writes without overwriting newer runs.
Integration coverage closes one Node
server and proves that a fresh server can rediscover and observe a file-backed
run whose execution worker remained active.
