---
"migrate-sdk": minor
"@migrate-sdk/tui": minor
---

Allow local CLI and TUI clients to identify immutable migration application
builds with `MIGRATE_SERVER_BUILD_ID`. Changing the build ID starts a new local
Node Migrate Server endpoint while active runs on the previous endpoint continue
to drain.
