# Implement Single-Definition Rollback

Status: done

## Parent

[Explicit Rollback Pipelines](../PRD.md)

## What to build

Implement the core rollback tracer bullet for one migration definition. `rollbackMigration(definition)` should select all rollbackable item states for the definition, execute side-effect-only rollback command plans through the existing destination command machinery, delete item state immediately after each successful rollback, preserve item state on failures, and return a rollback-specific summary.

Keep the public rollback usage documentation aligned with the implemented single-definition behavior.

## Acceptance criteria

- [x] `rollbackMigration(definition)` rolls back all rollbackable item states for the definition.
- [x] Rollback execution uses durable item state and does not call source cursor reads or source identity lookups.
- [x] Rollback execution does not update or clear source cursor state.
- [x] The rollback pipeline receives the full narrowed rollbackable item state and a minimal rollback context.
- [x] Rollback command execution reuses the existing destination plugin, destination command definitions, destination command context, destination command executor, and destination retry strategy.
- [x] Destination command context uses the rollback run id, source identity, source version when present, and previous state set to the rollbackable item state.
- [x] Rollback command plans must contain at least one command.
- [x] Rollback command plans reject identity-bearing commands.
- [x] Rollback pipeline failures and destination command execution failures count as item-level rollback failures.
- [x] Item-level rollback failures preserve original item state and do not stop remaining selected item states from being attempted.
- [x] Successful item rollback deletes item state immediately.
- [x] Destination identities or versions returned by rollback command execution do not update item state.
- [x] Migrated, needs-update, and failed-with-destination-identity states are rollbackable.
- [x] Skipped states and failed states without destination identity count as skipped and remain unchanged.
- [x] Rollback summaries use `rolledBack`, `failed`, and `skipped` counts.
- [x] Rollback definition and top-level summary status are failed only when the failed count is greater than zero.
- [x] Rollback summary counts are aggregate-only and do not include item-level rollback error details.
- [x] The first slice does not add rollback-specific fields to durable migration run state.
- [x] The rollback API design doc reflects the implemented single-definition behavior.

## Blocked by

- [Add Rollback API Shape and Store Deletion](./01-add-rollback-api-shape-and-store-delete.md)
