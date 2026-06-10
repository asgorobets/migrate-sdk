# Add Source Inventory Scan Status

Status: done

## Parent

[Migration Status Command](../PRD.md)

## What to build

Extend standalone status with an opt-in Source Inventory Scan. When source scanning is enabled, status should compare current source inventory against durable item state, surface invalid payloads and duplicate Source Identities as structured warnings, and return source inventory counts without changing migration progress.

The scan is intentionally read-only. It starts from the beginning of each source, follows normal source cursor windows, never reads or writes the persisted Source Cursor, and fails only when the source inventory cannot be completely read.

## Acceptance criteria

- [x] Standalone status accepts an option to scan source inventory.
- [x] Source Inventory Scan starts from the beginning of the source.
- [x] Source Inventory Scan follows normal source cursor windows until exhausted.
- [x] Source Inventory Scan does not read persisted Source Cursor progress.
- [x] Source Inventory Scan does not write persisted Source Cursor progress.
- [x] Source Inventory Scan does not write Migration Item State.
- [x] Source Inventory Scan does not create Migration Run State.
- [x] Source Inventory Scan validates each source item payload with the Source Payload Schema.
- [x] Invalid source payloads are counted in source status.
- [x] Invalid source payloads are returned as schema-backed status warnings.
- [x] Invalid source payloads do not fail the whole status request.
- [x] Invalid source payloads do not persist failed item states.
- [x] Duplicate Source Identities are counted in source status.
- [x] Duplicate Source Identities are returned as schema-backed status warnings.
- [x] Duplicate Source Identities do not fail the whole status request.
- [x] Duplicate counts count duplicates after the first occurrence.
- [x] Valid, non-duplicate source identities with no durable item state count as unprocessed.
- [x] Durable item states whose source identity is absent from the current scan count as orphaned.
- [x] Durable status buckets continue to count all durable item states, including orphaned states.
- [x] Source read failures fail the status effect because the inventory is incomplete.
- [x] Source read failures preserve the same source plugin error boundary used by migration runs.
- [x] Source scan concurrency applies across Migration Definitions.
- [x] Source scan concurrency does not parallelize cursor windows within one definition.
- [x] Source scan concurrency defaults to one.
- [x] Source scan concurrency preserves output row order.
- [x] Source scan concurrency is bounded by the normalized request value.
- [x] Source-scan status may reuse detailed item-state listing to compute orphaned counts.
- [x] The first source-scan implementation does not add a batch item-state lookup primitive.
- [x] Tests cover source scans starting from the beginning while ignoring persisted cursor progress.
- [x] Tests cover multi-window source scans.
- [x] Tests cover invalid payload warnings and counts.
- [x] Tests cover duplicate Source Identity warnings and counts.
- [x] Tests cover unprocessed source identity counts.
- [x] Tests cover orphaned durable state counts.
- [x] Tests cover source read failures.
- [x] Tests cover bounded concurrency across definitions and stable report order.

## Blocked by

- [Add Durable-Only Standalone Status](./01-add-durable-only-standalone-status.md)
