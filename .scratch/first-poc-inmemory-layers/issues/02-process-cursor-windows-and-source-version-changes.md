# Process cursor windows and Source Version changes

Status: ready-for-agent

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Extend the in-memory runtime to process Source Cursor Windows instead of only a single Source Item. The runner should advance Source Cursors after processed windows, skip unchanged terminal item states, and reprocess Source Items whose Source Version changed.

This slice proves incremental discovery semantics without introducing external source systems.

## Acceptance criteria

- [ ] The in-memory SourcePlugin can return Source Items in deterministic cursor windows.
- [ ] The runner loops cursor windows until discovery is complete.
- [ ] The MigrationStore records the committed Source Cursor after each processed Source Cursor Window.
- [ ] Unchanged migrated and skipped Migration Item States are not reprocessed in normal mode.
- [ ] Changed Source Version causes the Source Item to be processed again.
- [ ] Cursor advancement continues even when a processed window contains item-level failures covered by later behavior.
- [ ] Tests verify cursor looping, cursor commits, unchanged detection, and Source Version reprocessing.

## Blocked by

- [01 - Run one Source Item through in-memory runtime](01-run-one-source-item-through-in-memory-runtime.md)
