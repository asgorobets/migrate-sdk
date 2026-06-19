# Add In-Memory And CSV Total Discovery

Status: ready-for-agent
Type: AFK

## Parent

[Optional Source Item Total Discovery](../PRD.md)

## What to build

Implement source-native total discovery for the in-memory and CSV source plugins after the shared contract exists.

In-memory should return the configured `items.length`. CSV should count the same Source Items the CSV source would emit for the current file and source configuration by using the CSV source's native file-loading and parsing path. Count failures should degrade to unknown progress and must not affect run correctness.

Covers user stories 2-8, 14-16, 18-19, and 23-24.

## Acceptance criteria

- [x] In-memory total discovery returns the configured item count directly from `items.length`.
- [x] In-memory total discovery treats zero items as a known zero total.
- [x] In-memory `batchSize` affects Source Cursor Window size but does not affect the discovered total.
- [x] In-memory total discovery does not call source reads or identity lookup.
- [x] CSV total discovery uses the CSV source's existing load and parse behavior instead of a separate counting parser.
- [x] CSV total discovery counts the Source Items selected for the current configuration.
- [x] CSV totals respect dialect, header, empty-row, identity, version, and source schema behavior that affects emitted Source Items.
- [x] CSV total discovery returns a typed unknown total when the file cannot be loaded or parsed for progress purposes.
- [x] CSV total discovery failures surface as progress warnings and do not create Migration Item State or Migration Diagnostics.
- [x] CSV read behavior remains authoritative for migration correctness after a total discovery failure.
- [x] The in-memory and CSV source plugins both expose the optional capability in their configured source output.
- [x] Tests cover known in-memory totals, known CSV totals, CSV configuration-sensitive counts, CSV discovery failure, and preservation of normal migration execution after a discovery failure.

## Blocked by

[Add Source Item Total Discovery Contract](./01-add-source-item-total-discovery-contract.md)

## Completion notes

Implemented native total discovery for in-memory and CSV sources. In-memory reports `items.length` without reads or lookups. CSV reuses its file load and parser path, counts parsed Source Items, and returns an unknown failed total for count-time load or parse failures while leaving read execution authoritative.
