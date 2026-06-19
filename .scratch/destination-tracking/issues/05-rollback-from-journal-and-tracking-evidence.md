# Rollback From Journal And Tracking Evidence

Status: ready-for-agent

## Parent

[Destination Tracking](../PRD.md)

## What to build

Update rollbackability and rollback execution to use durable destination tracking evidence instead of singular destination identity. Rollback should receive decoded process journal entries, optional tracking record state, and previous failed rollback attempts. The user-authored rollback effect decides how to compensate, no-op, or fail for manual correction. Successful rollback deletes item state. Failed rollback preserves the original item state and appends a failed rollback-attempt journal segment.

Rewrite rollback examples/tests away from destination identity and removed destination model rollback assumptions.

## Acceptance criteria

- [ ] Rollback requires an explicit rollback pipeline when selected item state exists; runtime no longer exports a status-derived rollback type based on status or `tracking record`.
- [ ] Rollback input exposes decoded process journal entries and a tracking record when present.
- [ ] Rollback code can narrow process journal entries with Destination Change Descriptors.
- [ ] Progress-only successful items are passed to rollback when selected and a rollback pipeline exists; an empty journal or missing tracking record is a user-authored no-op or cleanup decision.
- [ ] A failed rollback preserves the original item state.
- [ ] A failed rollback appends a separate rollback-attempt journal segment with attempt evidence and failure metadata.
- [ ] A later rollback retry can see the original process segment and previous failed rollback-attempt segments.
- [ ] A successful rollback deletes item state, including process and rollback-attempt journal segments.
- [ ] Rollback examples/tests no longer depend on singular `tracking record` or removed destination model identity behavior.
- [ ] No new removed destination model behavior, examples, or tests are added.
- [ ] Existing typecheck and tests pass after the migrated coverage is updated.

## Blocked by

- [Run Destination Helpers Inline And Record Journaled Changes](./02-run-destination-helpers-inline-and-record-journaled-changes.md)
- [Add Tracking Record Contracts And Reference Lookup](./03-add-tracking-record-contracts-and-reference-lookup.md)
