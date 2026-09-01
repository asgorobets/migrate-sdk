---
"migrate-sdk": minor
---

CSV sources can now set `batchSize` to emit bounded cursor windows. This makes
committed progress observable during large CSV migrations while retaining the
existing unbounded behavior by default. Durable CSV cursor row positions remain
integer-validated.

Add a persistent SQLite catalog example backed by checked-in CC0 Wikidata CSV
metadata, including deterministic failures, skips, updates, retry, concurrency,
dependency groups, and rollback scenarios in the TUI. Fixture setup
only resets directories it previously created, and the source schema rejects
unknown fixture dispositions. The local Node Migrate Server now loads this and
other Node migration configurations on behalf of the Bun-rendered TUI.
