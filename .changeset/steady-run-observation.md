---
"migrate-sdk": minor
"@migrate-sdk/tui": minor
---

Separate Migration Run observation from run control. The Migrate Protocol
can observe server-owned inline work by Migration Run id and request an explicit
run-scoped stop, while provider-owned runs report stopping as unsupported until
their Execution Adapter implements cancellation.

Keep the local Node Migrate Server alive when its TUI client disconnects during
active runs. The server owns independent execution and cancellation handles for
each run, allowing non-overlapping migrations to execute concurrently while
Migration Definition Locks reject conflicting plans. A later TUI session
reconnects over local Effect RPC, navigation changes only the focused run
observation, and closing the TUI no longer stops any migration.
