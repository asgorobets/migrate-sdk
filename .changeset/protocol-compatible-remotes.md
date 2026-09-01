---
"migrate-sdk": patch
"@migrate-sdk/tui": patch
---

Allow remote TUI clients to connect to Migrate Servers from a different SDK
release when both sides implement the same Migrate Protocol version. SDK version
metadata remains available for diagnostics, while local socket connections keep
their exact SDK identity check.
