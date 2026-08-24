---
"migrate-sdk": minor
"@migrate-sdk/tui": minor
---

Add a versioned, schema-backed Migrate Protocol with Effect RPC handlers for
dashboard discovery, messages, planning, execution, streaming observation,
cancellation, source scans, source identity history, and lock recovery.

Run local migration configurations in a Node Migrate Server child process while
the OpenTUI renderer remains in Bun. The npm launcher passes its exact Node
executable to the renderer, plans are revalidated by fingerprint before
execution, and live progress is multiplexed over child-process IPC.
