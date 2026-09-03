---
"migrate-sdk": minor
"@migrate-sdk/commercetools": minor
"@migrate-sdk/workflow-sdk": minor
---

Use destination bulk APIs without giving up per-item migration safety.

`migrate-sdk` now supports `processBatch` as an opt-in alternative to `process`.
One callback can coordinate all eligible items from a source cursor window,
use a bulk API or inspect sibling items, and return one deferred result (a
settlement) per item. The SDK still saves tracking, success or failure, retry
eligibility, and rollback state independently for every source item. Failed
items can be retried without repeating successful siblings. Journaling and
rollback retain their existing per-item behavior.

Destination helpers can now declare typed journal extensions for durable data
that does not fit the SDK's standard change or diagnostic entries. Each helper
can read, replace, or remove its own named value without overwriting
compensation evidence or another helper's extension. Extensions work in both
`process` and `processBatch`; they are not batch or attempt records.

`@migrate-sdk/commercetools` adds Product Draft imports through the
commercetools Import API. It splits large source windows by the Import API's
count and payload limits, submits requests with bounded concurrency, polls each
Import Operation, correlates it by product key, and journals the operation data
needed to recover interrupted or partially successful imports in a typed,
helper-owned journal extension. The package
includes an inline example and opt-in live tests against a real commercetools
Project.

`@migrate-sdk/workflow-sdk` adds `disableWorkflowStepRetries` for cursor-work
steps. Existing Workflow SDK applications should apply it to their cursor and
orphan-reconciliation page steps so an automatically retried step cannot move
on from an already committed cursor using stale workflow state. Lifecycle and
finalization steps should keep their normal retry policy. This reduces unsafe
automatic replay but does not provide exactly-once delivery.

No public API was removed or renamed. Existing migration definitions that use
`process` continue to work unchanged, and existing journals remain readable. A
migration definition chooses either `process` or `processBatch`, never both.
