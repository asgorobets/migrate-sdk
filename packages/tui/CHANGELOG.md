# @migrate-sdk/tui

## 0.8.0

### Minor Changes

- 0acb9ae: Add a versioned, schema-backed Migrate Protocol with Effect RPC handlers for
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
  
  Add active-run discovery and run-based observation to the unreleased Migrate
  Protocol. Dashboard snapshots include active runs so the TUI reads
  durable status once per refresh. Reconnection preserves failed terminal states
  and observes through a Migration Definition Lock still owned by the run.
  Migration Stores retain Migration Run State by Migration Run id when a later run
  replaces a definition's latest state. Non-transactional stores commit that
  authoritative run record before latest-definition projections, and retries
  repair interrupted projection writes without overwriting newer runs.
  Integration coverage closes one Node
  server and proves that a fresh server can rediscover and observe a file-backed
  run whose execution provider process remained active.
- 1537643: Add an interactive terminal interface for discovering, inspecting, running, retrying, and rolling back migrations. Targeted runs accept multiple source identities in one SDK operation, and the TUI can compose them from durable item history. Closing the TUI detaches its observations while active runs continue until explicitly stopped or completed, and the command uses the migration project's compatible SDK version. Session activity keeps a chronological, scrollable record of statuses, notices, warnings, errors, and observed run lifecycle changes, provides complete event details, and exports retained entries as JSON Lines.
- 9002aaa: Allow local CLI and TUI clients to identify immutable migration application
  builds with `MIGRATE_SERVER_BUILD_ID`. Changing the build ID selects a separate
  local Node Migrate Server endpoint while active runs on the previous endpoint
  continue to drain.
- 23bdba4: Stream complete migration-dashboard snapshots through persistent RPC streams
  and resumable HTTP leases, while keeping focused run detail and client
  navigation independent from aggregate status observation.
- 2879a84: Separate Migration Run observation from run control. The Migrate Protocol
  can observe server-owned inline work by Migration Run id and request an explicit
  run-scoped stop, while provider-owned runs report stopping as unsupported until
  their Execution Adapter implements cancellation.
  
  Keep the local Node Migrate Server alive when its TUI client disconnects during
  active runs. The server owns independent execution and cancellation handles for
  each run, allowing non-overlapping migrations to execute concurrently while
  Migration Definition Locks reject conflicting plans. A later TUI session
  reconnects over local Effect RPC, navigation changes only the focused run
  observation, and closing the TUI no longer stops any migration.
- bb977d4: Expose the Migrate Server through a Web-standard Effect RPC HTTP handler and
  add bounded, resumable run-observation leases with opaque resume tokens and
  absolute durable progress snapshots. Lease resume tokens retain the durable
  observation anchor so reconnects address the selected run directly. Transient
  lifecycle states and warnings are delivered with the next progress or completion
  checkpoint, and a terminal event is emitted only after the final durable
  progress snapshot.
  
  Let the TUI connect to a remote Migrate Server with `--server`, authenticate
  with an environment-provided Bearer token, reconnect observation leases after
  HTTP or serverless function boundaries, and expose the same complete operation
  contract used by local Migrate Servers. Remote connections require HTTPS outside
  loopback development and a matching Migrate SDK version, while HTTP hosts must
  provide request authorization or explicitly delegate it to authenticated
  infrastructure.
  
  Separate registry-backed Migrate Server construction from local
  `migrate.config.*` discovery. Remote hosts can construct the server directly
  from an imported registry and executable, while config paths remain private to
  the local CLI/TUI bootstrap.

### Patch Changes

- b919a6e: Record a separate durable outcome for every migration definition in a shared
  run. A failed group run no longer marks successful dependencies or unstarted
  siblings as failed, and retries use the dependency's own latest outcome.
  
  SQL Migration Stores can upgrade to schema version 2 to retain definition
  outcomes alongside the aggregate run lifecycle.
- Updated dependencies [0acb9ae]
- Updated dependencies [1537643]
- Updated dependencies [b919a6e]
- Updated dependencies [9002aaa]
- Updated dependencies [b919a6e]
- Updated dependencies [23bdba4]
- Updated dependencies [54f4a90]
- Updated dependencies [57ca6f0]
- Updated dependencies [2879a84]
- Updated dependencies [bb977d4]
  - migrate-sdk@0.8.0
