# Make Update Backlog Resumable

Status: ready-for-agent

## Parent

[Run Update Rescan](../PRD.md)

## What to build

Make update intent durable after partial or interrupted update runs. Remaining Needs Update state should be visible after an update run does not complete all scheduled work, and a later normal run should continue that backlog without requiring the operator to pass `--update` again.

This slice should also cover Source Items that were scheduled for update but are not encountered during the reset source scan. Missing scheduled items should remain pending Needs Update work instead of being silently treated as successful deletion or successful update.

## Acceptance criteria

- [x] A partial update run leaves unprocessed scheduled items in Needs Update state.
- [x] A later normal run processes remaining Needs Update backlog without requiring update intent.
- [x] Remaining Needs Update backlog is visible through existing status/count behavior.
- [x] Source Items scheduled for update but not encountered during reset cursor discovery remain Needs Update.
- [x] Missing scheduled Source Items are not treated as successful deletion.
- [x] Missing scheduled Source Items are not silently converted back to migrated state.
- [x] Store errors during update preparation fail the run without erasing already scheduled conservative state.
- [x] Normal failed and Needs Update backlog behavior remains compatible with update-created Needs Update state.
- [x] Direct source identity lookup recovery continues to work for remaining Needs Update backlog after the initial update scan.
- [x] Scan-oriented sources are not forced into one source identity lookup per migrated item during the initial update run.

## Blocked by

- [Execute Update Rescan For Migrated Items](./02-execute-update-rescan-for-migrated-items.md)
