# @migrate-sdk/workflow-sdk

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
