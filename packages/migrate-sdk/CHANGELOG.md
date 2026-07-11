# migrate-sdk

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
