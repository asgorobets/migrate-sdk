# @migrate-sdk/commercetools

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

### Patch Changes

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

## 0.4.0

### Minor Changes

- e00802b: Introduce per-definition source runtimes and separate durable execution jobs from the public migration executable boundary. Update the Commercetools and Workflow adapters to the new authoring contracts.

## 0.3.0

## 0.2.0

### Minor Changes

- 7b011ee: Simplify the Commercetools destination API so migration code can pass Commercetools SDK drafts and typed update actions directly to destination helpers.

  Create helpers now accept the corresponding SDK draft shape without requiring exported `*DraftSchema` wrappers. Update helpers now accept `{ selector, version, actions }` with typed SDK update actions directly, instead of requiring callers to build updates through `make*Update` action-builder factories.

  The schema-backed action-builder factories and draft schema exports have been removed from the public destination surface. Custom-field builders remain available as pure helpers and now cover supported non-product resources: business units, customers, inventory entries, product selections, and stores.

## 0.1.0

### Minor Changes

- initial release

### Patch Changes

- Updated dependencies
  - migrate-sdk@0.1.0
