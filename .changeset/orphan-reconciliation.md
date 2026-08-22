---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
"@migrate-sdk/commercetools": minor
---

Add Rollback Orphans to the TypeScript runner with `rollbackOrphans: true` and
to the CLI with `--rollback-orphans`. The migration performs a complete Source
Inventory Scan before rolling back durable Migration Item States that were not
observed. Successful rollback deletes the item state, while failed rollback
preserves the state and its rollback-attempt evidence.

Migration Item State now records its latest Source Inventory observation, and
every Migration Store exposes methods to observe existing item state and list
orphan candidates with bounded, deletion-safe keyset pagination. The In-Memory,
File, SQL, and Commercetools Migration Stores implement these operations. SQL
fresh-schema initialization includes the required observation columns and
indexes; existing schemas are not upgraded automatically.

The Workflow SDK executes the same Source Inventory Scan and Rollback phases
through its durable workflow boundary.
