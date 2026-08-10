---
"migrate-sdk": minor
"@migrate-sdk/commercetools": patch
---

Add attached inline run handles with signal-driven observation and cooperative
cancellation. The CLI now drains active migration work after Ctrl+C, protects
partial cursor windows, and requires explicit confirmation before an unsafe
second interrupt. Once drained, a cancelled CLI command exits with code 130.
Terminal state is persisted before definition locks are released, including
unexpected execution defects. Detached executors continue to return provider
execution identity without SDK polling.
