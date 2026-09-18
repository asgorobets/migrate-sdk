# migrate-sdk

## 0.13.2

## 0.13.1

## 0.13.0

### Minor Changes

- ec05d4d: Add `migrate run articles --limit 1` to try the next eligible source item before
  running a larger migration. The limit applies separately to every migration in
  the run, including explicit lists, `--group`, `--all`, and dependencies included
  with `--with-dependencies`. Unchanged migrated items do not use the limit;
  failures and skips do. Runs retain their place safely and report success when
  the requested work succeeds. Stopping early does not mark the migration complete;
  an existing completion record is preserved.
  The CLI refuses to start if a server drops the requested limit.
  
  Workflow runs also handle migrations registered in a different order from their
  dependencies, including cleanup when a worker fails.
  
  Normal runs now process eligible items in source order. Failed and needs-update
  items no longer run ahead of newly discovered items. Full scans remain the
  default; use `--rescan` or a targeted retry to revisit items behind a saved
  checkpoint after interruption or during incremental migration.

## 0.12.0

### Minor Changes

- 1e9aa19: Rollback confirmations now explain which migrations will be rolled back and why dependent migrations go first. The TUI shows the execution order and uses one confirmation. Choose between Include dependencies, recommended and selected by default, and Selected only. When dependent records remain, Selected only explains the consequences and confirms forced rollback; otherwise it keeps dependency safety checks enabled.
  
  Migrate Server now includes dependent migrations only when explicitly requested, matching the SDK and CLI defaults. The TUI requests inclusion by default and lets the operator change scope before confirming. CLI help and rollback errors explain that force skips safety checks without changing the selected migrations.
  
  Migration completion is now stored separately from operation history. Finishing a full source pass unlocks dependencies even when individual items failed or need updates. Selected-item runs and retries alone do not mark a migration complete. Removing an entry during rollback clears completion and resets the source cursor immediately so the next run can restore removed items; no-op rollbacks preserve it. The dashboard and CLI show completion separately from the last operation.
  
  Existing SQL stores need one schema upgrade to version 3, adding operation history and completion together. File and Commercetools stores gain separate completion records without an upgrade command. Existing migrations need a new full forward pass to establish completion. Custom stores must implement the completion and rollback-item transitions and accept named run-start inputs with an explicit operation. Successful forward orphan cleanup preserves completion; partially failed or cancelled cleanup after removal requires another source pass.
  
  Run history continues to distinguish forward runs from rollbacks, including Workflow SDK execution.
  
  Run and rollback confirmations share a complete numbered plan, with migration names shown only in the plan. Run, rescan, update, and retry prompts use short action descriptions and explain that forcing past dependencies may cause item failures. Rollback buttons use the fixed label “Rollback selected”.
  
  The TUI can now connect to an outdated SQL store and show an upgrade popup before loading the dashboard. Review the changes, upgrade through the server, and continue in the same session. Errors stay visible for retry. Local servers reuse the existing SQL store configuration; remote hosts supply the SQL administration target. These server operations require Migrate Protocol v2, so update clients and servers together. The SQL schema remains version 3.

## 0.11.0

### Minor Changes

- 8af1c85: Intentionally skipped items no longer appear as errors in traces. Skipped items
  keep their reason and history of changes. Skipping does not undo changes already
  made.
  
  **Breaking change:** Update migration code that skips items:
  
  - In a pipeline, replace `return yield* skipItem(reason)` with
    `return skipItem(reason)`.
  - For a batch item, replace `Effect.fail(skipItem(reason))` with
    `Effect.succeed(skipItem(reason))`.
  - Replace `new SkipItem({ reason })` with `skipItem(reason)`.
  - If a helper returns a skip, return that value from the calling pipeline too.
    Returning a skip only exits the function that returns it.
  
  Processing must finish with either no return value (`undefined`) or
  `skipItem(reason)` with a string reason. Other results now fail the item, including
  in JavaScript configurations. If your pipeline returns a write operation's result,
  use `.pipe(Effect.asVoid)` to discard that result after the operation finishes.
  
  Skipping creation of a required reference still fails the item that needs it.
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
- ff73771: Keep SQLite migration progress responsive while a migration is writing results.
  Opening an existing migration store now checks its schema without requesting a
  write lock, preventing dashboard updates from blocking the migration or causing
  connection timeouts. No configuration changes are needed.

## 0.10.0

### Minor Changes

- bbb2a37: With Workflow SDK, you can now update previously migrated entries, run selected entries by ID, or rerun only failed or skipped entries. Selecting entries avoids a full scan and leaves your saved progress in place. Updates keep existing tracking information, and later runs pick up unfinished retries and updates before continuing.
  
  Failed runs can also release their locks after a migration is renamed or removed, so those locks do not block future runs. If you remove an entire registry, keep its original `MigrationStore` available to the Workflow steps so they can finish cleanup.

## 0.9.0

### Minor Changes

- 612c3b2: Use destination bulk APIs without giving up per-item migration safety.
  
  `migrate-sdk` now supports `processBatch` as an opt-in alternative to `process`.
  One callback can coordinate all eligible items from a source cursor window,
  use a bulk API or inspect sibling items, and return one deferred result (a
  settlement) per item. The SDK still saves tracking, success or failure, retry
  eligibility, and rollback state independently for every source item. Failed
  items can be retried without repeating successful siblings. Journaling and
  rollback retain their existing per-item behavior.
  
  Destination helpers can now declare typed journal extensions for durable data
  that does not fit the SDK's standard change or diagnostic entries. Each helper
  can read, replace, or remove its own named value without overwriting
  compensation evidence or another helper's extension. Extensions work in both
  `process` and `processBatch`; they are not batch or attempt records.
  
  `@migrate-sdk/commercetools` adds Product Draft imports through the
  commercetools Import API. It splits large source windows by the Import API's
  count and payload limits, submits requests with bounded concurrency, polls each
  Import Operation, correlates it by product key, and journals the operation data
  needed to recover interrupted or partially successful imports in a typed,
  helper-owned journal extension. The package
  includes an inline example and opt-in live tests against a real commercetools
  Project.
  
  `@migrate-sdk/workflow-sdk` adds `disableWorkflowStepRetries` for cursor-work
  steps. Existing Workflow SDK applications should apply it to their cursor and
  orphan-reconciliation page steps so an automatically retried step cannot move
  on from an already committed cursor using stale workflow state. Lifecycle and
  finalization steps should keep their normal retry policy. This reduces unsafe
  automatic replay but does not provide exactly-once delivery.
  
  No public API was removed or renamed. Existing migration definitions that use
  `process` continue to work unchanged, and existing journals remain readable. A
  migration definition chooses either `process` or `processBatch`, never both.

## 0.8.2

### Patch Changes

- 27443bc: Support every server-backed CLI command through `--server`, including registry
  listing, dependency graphs, status, messages, and lock recovery. Remote HTTP
  authentication failures now report 401 and 403 permission errors with a token
  configuration hint. Finalize the pre-adoption Migrate Protocol v1 baseline with
  static registry metadata and canonical selection-based status and message
  reports; servers from the earlier incomplete v1 draft must be redeployed.

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
- b919a6e: CSV sources can now set `batchSize` to emit bounded cursor windows. This makes
  committed progress observable during large CSV migrations while retaining the
  existing unbounded behavior by default. Durable CSV cursor row positions remain
  integer-validated.
  
  Add a persistent SQLite catalog example backed by checked-in CC0 Wikidata CSV
  metadata, including deterministic failures, skips, updates, retry, concurrency,
  dependency groups, and rollback scenarios in the TUI. Fixture setup
  only resets directories it previously created, and the source schema rejects
  unknown fixture dispositions. The local Node Migrate Server now loads this and
  other Node migration configurations on behalf of the Bun-rendered TUI.
- 23bdba4: Stream complete migration-dashboard snapshots through persistent RPC streams
  and resumable HTTP leases, while keeping focused run detail and client
  navigation independent from aggregate status observation.
- 54f4a90: Manage SQL Migration Store schemas with bundled Effect SQL migrations. Fresh
  stores install the current bundled schema, while existing stores are checked without
  mutation and rejected when their history or shape is older, newer, divergent,
  partial, or untracked. TypeScript callers can inspect a stable schema plan and
  explicitly apply it with `SqlMigrationStore.planSchema` and
  `SqlMigrationStore.applySchemaPlan`.
  
  CLI callers can configure an explicit SQL store target and use
  `migrate store schema status` to inspect it or `migrate store schema upgrade`
  to apply an interactively confirmed or exact plan-ID-approved upgrade.
- 57ca6f0: Expose runtime-neutral HTTP and browser Migrate clients that connect directly
  to the complete authenticated Migrate Server protocol. Browser connections can
  cancel setup and observation independently from durable migration execution.
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

## 0.7.0

### Minor Changes

- 9213153: Sources now use full discovery by default. Completed runs clear their cursor, so
  the next run scans from the beginning and can discover changes anywhere in the
  source while still skipping items whose version has not changed. Sources with a
  reliable high-water cursor can opt into `discovery: "incremental"` instead.

  Customers can use `migrate run --rescan` to ignore a saved cursor without
  forcing unchanged items through the Process Pipeline. Run plans and status show
  the configured discovery mode and warn when an incremental run trusts its saved
  cursor.

  Commercetools sources now page by `(lastModifiedAt, id)` so new and updated
  resources are not missed because of UUID ordering. Existing Commercetools
  migrations with a saved cursor must run once with `--rescan` after upgrading to
  replace the old cursor shape.

- 3bca36d: Add Rollback Orphans to the TypeScript runner with `rollbackOrphans: true` and
  to the CLI with `--rollback-orphans`. The migration performs a complete Source
  Inventory Scan before rolling back durable Migration Item States that were not
  observed. Successful rollback deletes the item state, while failed rollback
  preserves the state and its rollback-attempt evidence.

  Migration Item State now records its latest Source Inventory observation, and
  every Migration Store exposes methods to observe existing item state and list
  orphan candidates with bounded, deletion-safe keyset pagination. The In-Memory,
  File, SQL, and Commercetools Migration Stores implement these operations. SQL
  fresh-schema initialization includes the required observation columns and
  indexes; existing schemas are not upgraded automatically.

  The Workflow SDK executes the same Source Inventory Scan and Rollback phases
  through its durable workflow boundary.

## 0.6.0

### Minor Changes

- f3bffe2: Add an Effect SQL-backed Migration Store for PostgreSQL, SQLite, MySQL, and SQL
  Server with queryable relational state, dialect-native upserts, observable run
  lifecycle, and cross-process definition locks.
- cbad8e5: Let each migration definition declare one optional group, and select the
  aggregated group through the SDK or `run`, `rollback`, and `status` CLI commands
  with `--group`.
- 6406913: Add attached inline run handles with signal-driven observation and cooperative
  cancellation. The CLI now drains active migration work after Ctrl+C, protects
  partial cursor windows, and requires explicit confirmation before an unsafe
  second interrupt. Once drained, a cancelled CLI command exits with code 130.
  Terminal state is persisted before definition locks are released, including
  unexpected execution defects. Detached executors continue to return provider
  execution identity without SDK polling.

## 0.5.0

### Minor Changes

- 4d24c54: Add `ProcessPipelineFor`, `RollbackPipelineFor`, and `DestinationStubPipeline`
  plus contract-derived `TrackingRecordFor` and `MigrationItemStateFor` aliases
  for reusable migration callbacks. Remove lower-level tracking, rollback
  erasure, and process-scope construction helpers from the root authoring
  entrypoint. Remove ambient `Tracking.currentContext`; journal change and
  diagnostic entries inherit source identity from their owning Migration Item
  State, while destination payload schemas do not duplicate it. Keep runtime
  journal readers and destination-helper scope metadata off the public Tracking
  service.

  Public API migration guidance:

  - Replace `MigrationItemStateForTrackingContract` or
    `MigrationItemStateWithTrackingRecord` with
    `MigrationItemStateFor<typeof TrackingContract>`. Use
    `TrackingRecordFor<typeof TrackingContract>` when only the decoded record type
    is needed.
  - Replace reusable `ProcessPipeline` and `RollbackPipeline` annotations with
    `ProcessPipelineFor<typeof source, ProcessError, typeof TrackingContract>` and
    `RollbackPipelineFor<typeof TrackingContract, RollbackError>` respectively.
    This also replaces extracting rollback errors through the removed
    `MigrationDefinitionRollbackPipelineError` type.
  - `AnyRollbackMigrationDefinition` is no longer an author-facing root export.
    Keep concrete Migration Definitions inferred. Adapter code that needs the
    selected heterogeneous definition type can use
    `MigrationDefinitionExecutableRollbackPlan["definitions"][number]`.
  - Replace named `TrackingService` annotations with the exported `Tracking`
    service tag or its static `recordChange`, `logDiagnostic`, and `setRecord`
    operations.
  - Replace `TrackingProcessContext` and `Tracking.currentContext` reads with
    callback inputs: process receives `source.identity` plus
    `context.definitionId`, `context.runId`, and `context.previousState`; stubs
    receive `input.sourceIdentity` and their context; rollback receives
    `state.sourceIdentity` and its context.
  - `Tracking.layerProcessScope` and `Tracking.snapshot` have no authoring
    replacement because the runtime owns scope construction and finalization.
    Read durable journal evidence from `MigrationItemState.journal` in process
    previous state, rollback state, or store inspection instead.

  In `@migrate-sdk/commercetools`, `CommercetoolsResourceChange` no longer carries
  `sourceIdentity`; rollback and inspection code should read identity from the
  owning `MigrationItemState.sourceIdentity` instead.

- 4d24c54: Keep executable rollback plans aligned with run plans by exposing selected
  Migration Definitions directly while retaining tracking-aware rollback decoding
  inside the executor. Update Workflow SDK adapters for the simplified plan shape.

  `ExecutableRollbackDefinition` has been removed. Code consuming executable
  rollback plans should migrate from the wrapper shape to the selected definitions
  directly:

  ```ts
  // Before
  const definitions = plan.definitions.map(({ definition }) => definition);
  const firstDefinition = plan.definitions[0]?.definition;

  // After
  const definitions = plan.definitions;
  const firstDefinition = plan.definitions[0];
  ```

  Rollback and tracking callbacks remain available on each selected Migration
  Definition as `definition.rollback` and `definition.tracking`; tracking-aware
  stored-state decoding remains runtime-owned inside the executor.

## 0.4.0

### Minor Changes

- e00802b: Introduce per-definition source runtimes and separate durable execution jobs from the public migration executable boundary. Update the Commercetools and Workflow adapters to the new authoring contracts.

### Patch Changes

- e00802b: Preserve typed tracking records through processing and rollback pipelines, use the Effect clock for persisted timestamps, and tighten runtime schema validation.

## 0.3.0

### Minor Changes

- 6b37d1b: Add ability to break the migration lock and display lock status in migration status

## 0.2.0

### Minor Changes

- 7b011ee: Validate omitted required dependency state before running selected migrations. Runs now allow leaf migrations to execute without `--with-dependencies` when required dependencies have already completed successfully, while failed or missing dependency state is rejected unless `--force` is used.

  Dependency planning is now directional: run expansion follows required prerequisites, rollback expansion follows required dependents. Rollback no longer pulls parent migrations into a leaf rollback, and parent rollback can include dependent children with `--with-dependencies`.

  Migration definitions now declare ordering through `dependencies.required` and `dependencies.optional`.

## 0.1.0

### Minor Changes

- initial release
