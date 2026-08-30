---
"@migrate-sdk/tui": minor
"migrate-sdk": minor
---

Add an interactive terminal interface for discovering, inspecting, running, retrying, and rolling back migrations. Targeted runs accept multiple source identities in one SDK operation, and the TUI can compose them from durable item history. Active runs cancel cleanly before exit, background runs continue safely, and the command uses the migration project's compatible SDK version. Session activity keeps a chronological, scrollable record of statuses, notices, warnings, errors, and observed run lifecycle changes, provides complete event details, and exports retained entries as JSON Lines.
