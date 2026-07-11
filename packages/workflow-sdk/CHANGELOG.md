# @migrate-sdk/workflow-sdk

## 0.5.0

### Minor Changes

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

## 0.3.0

## 0.2.0

## 0.1.0

### Minor Changes

- initial release

### Patch Changes

- Updated dependencies
  - migrate-sdk@0.1.0
