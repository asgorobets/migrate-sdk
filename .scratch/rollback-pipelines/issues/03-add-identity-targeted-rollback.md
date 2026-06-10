# Add Identity-Targeted Rollback

Status: done

## Parent

[Explicit Rollback Pipelines](../PRD.md)

## What to build

Add source identity targeting to the single-definition rollback helper. Identity-targeted rollback should be a prefiltered mode for `rollbackMigration`, not a global source identity selection on `rollbackMigrations`, because source identities are scoped to a migration definition.

Keep the public rollback usage documentation aligned with the implemented targeted rollback behavior.

## Acceptance criteria

- [x] `rollbackMigration(definition, { sourceIdentities })` accepts one or more source identities.
- [x] Omitting `sourceIdentities` keeps the existing rollback-all behavior for one definition.
- [x] An empty `sourceIdentities` array is rejected as a rollback request validation failure.
- [x] Duplicate source identities are deduplicated while preserving first occurrence order.
- [x] Targeted rollback uses direct item-state lookup instead of scanning all item states.
- [x] Targeted identities with no item state count as skipped.
- [x] Targeted skipped states count as skipped and remain unchanged.
- [x] Targeted failed states without destination identity count as skipped and remain unchanged.
- [x] Targeted rollbackable states execute the same rollback command validation, destination execution, state deletion, and summary behavior as definition-wide rollback.
- [x] For targeted rollback, `rolledBack + failed + skipped` equals the deduplicated source identities requested.
- [x] `rollbackMigrations` does not accept global source identity selection in this slice.
- [x] The rollback API design doc reflects single-definition identity targeting and the absence of multi-definition identity targeting.

## Blocked by

- [Implement Single-Definition Rollback](./02-implement-single-definition-rollback.md)
