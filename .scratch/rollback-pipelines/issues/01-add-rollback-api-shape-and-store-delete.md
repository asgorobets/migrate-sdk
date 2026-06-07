# Add Rollback API Shape and Store Deletion

Status: done

## Parent

[Explicit Rollback Pipelines](../PRD.md)

## What to build

Add the public and durable foundations for explicit rollback pipelines without implementing full rollback execution yet. Migration definitions should be able to declare a rollback pipeline, the SDK should expose rollback request and summary shapes that mirror the migration run API, rollback request/preflight failures should use distinct rollback runtime errors, and migration stores should be able to delete item state after successful rollback.

Keep the public rollback design documentation aligned with the implemented API shape as this slice lands.

## Acceptance criteria

- [x] Migration definitions can declare an optional `rollback` pipeline beside the forward `pipeline`.
- [x] Rollback pipeline input and context types are exported consistently with existing migration definition types.
- [x] Rollbackable migration item state is represented as a narrowed item-state type that guarantees destination identity.
- [x] Rollback run summary and rollback definition summary types are added with `rolledBack`, `failed`, and `skipped` aggregate counts.
- [x] Public rollback request and result types mirror the existing migration run API style where applicable.
- [x] Distinct rollback runtime errors exist for public rollback request and preflight failures.
- [x] `MigrationStore` exposes a dedicated item-state deletion operation.
- [x] The in-memory migration store deletes item state through the new operation.
- [x] The file migration store deletes the persisted item-state JSON file through the new operation.
- [x] Store deletion behavior is covered by in-memory and file-store tests.
- [x] Public exports for rollback types and operations mirror the corresponding migration run exports.
- [x] The rollback API design doc reflects the implemented public type and store-deletion foundation.

## Blocked by

None - can start immediately
