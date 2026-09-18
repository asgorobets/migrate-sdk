---
"@migrate-sdk/tui": patch
---

Open the migration list without waiting for durable status, with background or manual status loading. Load messages on demand and reuse migration and group caches until observed progress invalidates them.

Keep earlier source counts when scanning another migration, and label the TUI action "Scan sources".
