---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

With Workflow SDK, you can now update previously migrated entries, run selected entries by ID, or rerun only failed or skipped entries. Selecting entries avoids a full scan and leaves your saved progress in place. Updates keep existing tracking information, and later runs pick up unfinished retries and updates before continuing.

Failed runs can also release their locks after a migration is renamed or removed, so those locks do not block future runs. If you remove an entire registry, keep its original `MigrationStore` available to the Workflow steps so they can finish cleanup.
