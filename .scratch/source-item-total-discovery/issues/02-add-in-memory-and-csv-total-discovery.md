# Add In-Memory And CSV Total Count

Status: ready-for-human
Type: AFK

## Parent

[Optional Source Item Total Count](../PRD.md)

## What to build

Implement source-native total count for the in-memory and CSV source plugins after the shared contract exists.

In-memory should return the configured `items.length`. CSV should count the same Source Items the CSV source would emit for the current file and source configuration by using the CSV source's native file-loading and parsing path. Count failures should degrade to unknown progress and must not affect run correctness.

Covers user stories 2-8, 14-16, 18-19, and 23-24.

## Acceptance criteria

- [x] In-memory total count returns the configured item count directly from `items.length`.
- [x] In-memory total count treats zero items as a known zero total.
- [x] In-memory `batchSize` affects Source Cursor Window size but does not affect the counted total.
- [x] In-memory total count does not call source reads or identity lookup.
- [x] CSV total count uses the CSV source's existing load and parse behavior instead of a separate counting parser.
- [x] CSV total count counts the Source Items selected for the current configuration.
- [x] CSV totals respect dialect, header, empty-row, identity, version, and source schema behavior that affects emitted Source Items.
- [x] CSV total count fails when the file cannot be loaded or parsed for progress purposes, and runtime progress degrades that failure to an unknown total.
- [x] CSV total count failures surface as progress warnings and do not create Migration Item State or Migration Diagnostics.
- [x] CSV read behavior remains authoritative for migration correctness after a total count failure.
- [x] The in-memory and CSV source plugins both expose the optional capability in their configured source output.
- [x] Tests cover known in-memory totals, known CSV totals, CSV configuration-sensitive counts, CSV count failure, and preservation of normal migration execution after a count failure.

## Blocked by

[Add Source Item Total Count Contract](./01-add-source-item-total-discovery-contract.md)

## Completion notes

Implemented native total count for in-memory and CSV sources. In-memory reports `items.length` without reads or lookups. CSV reuses its file load and parser path, counts parsed Source Items, and fails `countTotal` for count-time load or parse failures while leaving runtime progress to degrade the failure to an unknown total.
