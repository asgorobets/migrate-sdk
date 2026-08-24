---
"migrate-sdk": patch
"@migrate-sdk/commercetools": patch
"@migrate-sdk/workflow-sdk": patch
"@migrate-sdk/tui": patch
---

Record a separate durable outcome for every migration definition in a shared
run. A failed group run no longer marks successful dependencies or unstarted
siblings as failed, and retries use the dependency's own latest outcome.

SQL Migration Stores can upgrade to schema version 2 to retain definition
outcomes alongside the aggregate run lifecycle.
