# migrate-sdk

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
