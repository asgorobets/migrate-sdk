# Add Source Inventory Scan Status

Status: ready-for-agent

## Parent

[Migration Status Command](../PRD.md)

## What to build

Extend standalone status with an opt-in Source Inventory Scan. When source scanning is enabled, status should compare current source inventory against durable item state, surface invalid payloads and duplicate Source Identities as structured warnings, and return source inventory counts without changing migration progress.

The scan is intentionally read-only. It starts from the beginning of each source, follows normal source cursor windows, never reads or writes the persisted Source Cursor, and fails only when the source inventory cannot be completely read.

## Acceptance criteria

- [ ] Standalone status accepts an option to scan source inventory.
- [ ] Source Inventory Scan starts from the beginning of the source.
- [ ] Source Inventory Scan follows normal source cursor windows until exhausted.
- [ ] Source Inventory Scan does not read persisted Source Cursor progress.
- [ ] Source Inventory Scan does not write persisted Source Cursor progress.
- [ ] Source Inventory Scan does not write Migration Item State.
- [ ] Source Inventory Scan does not create Migration Run State.
- [ ] Source Inventory Scan validates each source item payload with the Source Payload Schema.
- [ ] Invalid source payloads are counted in source status.
- [ ] Invalid source payloads are returned as schema-backed status warnings.
- [ ] Invalid source payloads do not fail the whole status request.
- [ ] Invalid source payloads do not persist failed item states.
- [ ] Duplicate Source Identities are counted in source status.
- [ ] Duplicate Source Identities are returned as schema-backed status warnings.
- [ ] Duplicate Source Identities do not fail the whole status request.
- [ ] Duplicate counts count duplicates after the first occurrence.
- [ ] Valid, non-duplicate source identities with no durable item state count as unprocessed.
- [ ] Durable item states whose source identity is absent from the current scan count as orphaned.
- [ ] Durable status buckets continue to count all durable item states, including orphaned states.
- [ ] Source read failures fail the status effect because the inventory is incomplete.
- [ ] Source read failures preserve the same source plugin error boundary used by migration runs.
- [ ] Source scan concurrency applies across Migration Definitions.
- [ ] Source scan concurrency does not parallelize cursor windows within one definition.
- [ ] Source scan concurrency defaults to one.
- [ ] Source scan concurrency preserves output row order.
- [ ] Source scan concurrency is bounded by the normalized request value.
- [ ] Source-scan status may reuse detailed item-state listing to compute orphaned counts.
- [ ] The first source-scan implementation does not add a batch item-state lookup primitive.
- [ ] Tests cover source scans starting from the beginning while ignoring persisted cursor progress.
- [ ] Tests cover multi-window source scans.
- [ ] Tests cover invalid payload warnings and counts.
- [ ] Tests cover duplicate Source Identity warnings and counts.
- [ ] Tests cover unprocessed source identity counts.
- [ ] Tests cover orphaned durable state counts.
- [ ] Tests cover source read failures.
- [ ] Tests cover bounded concurrency across definitions and stable report order.

## Blocked by

- [Add Durable-Only Standalone Status](./01-add-durable-only-standalone-status.md)
