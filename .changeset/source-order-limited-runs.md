---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

Add `migrate run articles --limit 1` to try the next eligible source item before
running a larger migration. Unchanged migrated items do not use the limit;
failures and skips do. Runs retain their place safely and report success when
the requested work succeeds. Stopping early does not mark the migration complete;
an existing completion record is preserved.
The CLI refuses to start if a server drops the requested limit.

Normal runs now process eligible items in source order. Failed and needs-update
items no longer run ahead of newly discovered items. Full scans remain the
default; use `--rescan` or a targeted retry to revisit items behind a saved
checkpoint after interruption or during incremental migration.
