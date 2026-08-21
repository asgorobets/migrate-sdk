---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

Add the TypeScript and durable workflow contracts for requesting orphan
rollback with `rollbackOrphans: true`. Migration Item State can record its
latest Source Inventory observation, and every Migration Store exposes methods
to observe existing item state and list orphan candidates with keyset
pagination.

Store adapters awaiting their implementation expose both methods and fail with
`MigrationStoreError` when either is called.
