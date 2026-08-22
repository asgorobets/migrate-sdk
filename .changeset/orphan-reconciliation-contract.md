---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

Add the TypeScript and durable workflow contracts for requesting orphan
rollback with `rollbackOrphans: true`. Migration Item State can record its
latest Source Inventory observation, and every Migration Store exposes methods
to observe existing item state and list orphan candidates with keyset
pagination.

The File and SQL Migration Stores implement durable observation and stable,
bounded orphan pages, so Rollback Orphans remains safe across process
recreation. SQL stores add and index the observation columns through
idempotent schema upgrades for PostgreSQL, MySQL, SQL Server, and SQLite.
