---
"migrate-sdk": minor
"@migrate-sdk/workflow-sdk": minor
---

Keep executable rollback plans aligned with run plans by exposing selected
Migration Definitions directly while retaining tracking-aware rollback decoding
inside the executor. Update Workflow SDK adapters for the simplified plan shape.

`ExecutableRollbackDefinition` has been removed. Code consuming executable
rollback plans should migrate from the wrapper shape to the selected definitions
directly:

```ts
// Before
const definitions = plan.definitions.map(({ definition }) => definition)
const firstDefinition = plan.definitions[0]?.definition

// After
const definitions = plan.definitions
const firstDefinition = plan.definitions[0]
```

Rollback and tracking callbacks remain available on each selected Migration
Definition as `definition.rollback` and `definition.tracking`; tracking-aware
stored-state decoding remains runtime-owned inside the executor.
