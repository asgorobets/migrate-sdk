# Preserve Tracking Evidence Across Update Attempts

Status: ready-for-agent

## Parent

[Run Update Rescan](../PRD.md)

## What to build

Harden update attempts so previous destination tracking evidence is not lost when an update attempt fails, skips, or needs to be retried. A previously migrated item scheduled for update must keep enough Tracking Record and Destination Journal evidence for process retry, manual inspection, and rollback.

The completed slice should let update-aware process code read prior tracking evidence from previous Migration Item State, and should preserve that evidence when the update attempt does not produce a fresh successful migrated state.

## Acceptance criteria

- [ ] Update-aware process code can read prior Tracking Record evidence from previous Migration Item State.
- [ ] Update-aware process code can read prior Destination Journal evidence from previous Migration Item State.
- [ ] Process examples or tests treat both migrated and Needs Update previous states as previously tracked states.
- [ ] A failed update attempt preserves prior Tracking Record evidence where available.
- [ ] A failed update attempt preserves prior Destination Journal evidence where available.
- [ ] A skipped update attempt preserves prior evidence needed for retry or rollback.
- [ ] A failed tracking-record validation during update does not discard prior tracking evidence.
- [ ] A later retry can still access prior tracking evidence after a failed update attempt.
- [ ] Rollback input remains able to inspect the prior evidence after a failed update attempt.
- [ ] Successful update processing still replaces prior evidence with the fresh successful run's Tracking Record and Destination Journal evidence.

## Blocked by

- [Execute Update Rescan For Migrated Items](./02-execute-update-rescan-for-migrated-items.md)
