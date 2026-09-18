# @migrate-sdk/tui

## 0.13.2

### Patch Changes

- f30de8a: Open the migration list without waiting for durable status, with background or manual status loading. Load messages on demand and reuse migration and group caches until observed progress invalidates them.
  
  Keep earlier source counts when scanning another migration, and label the TUI action "Scan sources".

## 0.13.1

### Patch Changes

- a5ab1e4: Run a small number of items without an extra confirmation. The terminal app
  remembers your choice of **Next items** or **Source IDs** when you reopen
  **Run selected entries**.
  
  Use Tab and the arrow keys to change your choice. Pressing Space on **Run** or
  **Cancel** now activates that button without changing the items you selected.

## 0.13.0

### Minor Changes

- f2e6af8: Run a small sample from the TUI with Run selected entries. Choose Next items and
  enter a limit for each migration, including groups and dependencies, then review
  before starting. Switch to Source IDs to choose specific items as before.

### Patch Changes

- Updated dependencies [ec05d4d]
  - migrate-sdk@0.13.0

## 0.12.0

### Patch Changes

- 1e9aa19: Rollback confirmations now explain which migrations will be rolled back and why dependent migrations go first. The TUI shows the execution order and uses one confirmation. Choose between Include dependencies, recommended and selected by default, and Selected only. When dependent records remain, Selected only explains the consequences and confirms forced rollback; otherwise it keeps dependency safety checks enabled.
  
  Migrate Server now includes dependent migrations only when explicitly requested, matching the SDK and CLI defaults. The TUI requests inclusion by default and lets the operator change scope before confirming. CLI help and rollback errors explain that force skips safety checks without changing the selected migrations.
  
  Migration completion is now stored separately from operation history. Finishing a full source pass unlocks dependencies even when individual items failed or need updates. Selected-item runs and retries alone do not mark a migration complete. Removing an entry during rollback clears completion and resets the source cursor immediately so the next run can restore removed items; no-op rollbacks preserve it. The dashboard and CLI show completion separately from the last operation.
  
  Existing SQL stores need one schema upgrade to version 3, adding operation history and completion together. File and Commercetools stores gain separate completion records without an upgrade command. Existing migrations need a new full forward pass to establish completion. Custom stores must implement the completion and rollback-item transitions and accept named run-start inputs with an explicit operation. Successful forward orphan cleanup preserves completion; partially failed or cancelled cleanup after removal requires another source pass.
  
  Run history continues to distinguish forward runs from rollbacks, including Workflow SDK execution.
  
  Run and rollback confirmations share a complete numbered plan, with migration names shown only in the plan. Run, rescan, update, and retry prompts use short action descriptions and explain that forcing past dependencies may cause item failures. Rollback buttons use the fixed label “Rollback selected”.
  
  The TUI can now connect to an outdated SQL store and show an upgrade popup before loading the dashboard. Review the changes, upgrade through the server, and continue in the same session. Errors stay visible for retry. Local servers reuse the existing SQL store configuration; remote hosts supply the SQL administration target. These server operations require Migrate Protocol v2, so update clients and servers together. The SQL schema remains version 3.
- Updated dependencies [1e9aa19]
  - migrate-sdk@0.12.0

## 0.11.0

### Minor Changes

- 315434a: Add optional OpenTelemetry tracing to see where migrations spend time reading
  sources, processing batches, waiting, and saving results. Use traces to find slow
  steps and compare batch sizes or the number of items processed at once.
  
  To try it locally, start a trace receiver, then add `--otel` to the CLI or TUI:
  
  ```sh
  migrate run articles --otel --config migrate.config.ts
  migrate-tui --otel --config migrate.config.ts
  ```
  
  The default address is `http://localhost:4318/v1/traces`, with service name
  `migrate-sdk`. Existing `OTEL_*` environment variables override these defaults.
  Use any compatible service that accepts OTLP/HTTP JSON traces; no particular
  viewer is required.
  
  For scheduled scripts or applications using the SDK directly, provide
  `migrationTelemetryLayer` from `migrate-sdk/telemetry` and configure it with
  OpenTelemetry environment variables. Existing Effect tracing setups work too.
  See the [tracing setup guide](https://github.com/asgorobets/migrate-sdk/blob/main/docs/telemetry.md)
  for service configuration and examples.
  
  Tracing is optional. No configuration changes are needed if you do not use it.

### Patch Changes

- d3a0686: Update the Effect packages together to 4.0.0-rc.113. This fixes fresh SDK and TUI
  installations failing at startup with a missing `effect/ByteSize` module.
  
  If your project installs `effect` or `@effect/*` runtime packages directly, update
  them to 4.0.0-rc.113 alongside this release. Effect renamed some helpers in this
  release; for example, use `Config.String` instead of `Config.string` and
  `Flag.Boolean` instead of `Flag.boolean` in code that calls Effect directly.
  
  Migration CLI flags and OpenTelemetry environment variables stay the same. No
  global Effect or Bun installation is required.
- Updated dependencies [d3a0686]
- Updated dependencies [8af1c85]
- Updated dependencies [ff73771]
- Updated dependencies [315434a]
  - migrate-sdk@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [bbb2a37]
  - migrate-sdk@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [612c3b2]
  - migrate-sdk@0.9.0

## 0.8.2

## 0.8.1

### Patch Changes

- c6406a0: Allow remote TUI clients to connect to Migrate Servers from a different SDK
  release when both sides implement the same Migrate Protocol version. SDK version
  metadata remains available for diagnostics, while local socket connections keep
  their exact SDK identity check.

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
