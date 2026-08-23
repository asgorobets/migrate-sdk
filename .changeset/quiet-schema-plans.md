---
"migrate-sdk": minor
---

Manage SQL Migration Store schemas with bundled Effect SQL migrations. Fresh
stores install schema version 1, while existing stores are checked without
mutation and rejected when their history or shape is older, newer, divergent,
partial, or untracked. TypeScript callers can inspect a stable schema plan and
explicitly apply it with `SqlMigrationStore.planSchema` and
`SqlMigrationStore.applySchemaPlan`.

CLI callers can configure an explicit SQL store target and use
`migrate store schema status` to inspect it or `migrate store schema upgrade`
to apply an interactively confirmed or exact plan-ID-approved upgrade.
