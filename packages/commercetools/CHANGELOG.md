# @migrate-sdk/commercetools

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
