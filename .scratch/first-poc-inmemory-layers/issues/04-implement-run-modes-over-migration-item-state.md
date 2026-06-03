# Implement Run Modes over Migration Item State

Status: done

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Implement normal, failed, skipped, and item Run Modes over durable Migration Item State. Normal mode should process failed and needs-update backlog before cursor discovery. Targeted modes should use SourcePlugin.readByIdentity to reprocess known Source Identities.

## Acceptance criteria

- [x] Normal Run Mode processes failed backlog before cursor discovery.
- [x] Normal Run Mode processes needs-update backlog before cursor discovery.
- [x] Failed Run Mode processes only failed Migration Item States.
- [x] Skipped Run Mode processes skipped Migration Item States regardless of Source Version.
- [x] Item Run Mode processes exactly one Source Identity regardless of current state.
- [x] Targeted modes use SourcePlugin.readByIdentity.
- [x] Source identity lookup failures for known items can be recorded as item failures.
- [x] Tests verify normal backlog behavior, failed mode, skipped mode, and item mode.

## Blocked by

- [02 - Process cursor windows and Source Version changes](02-process-cursor-windows-and-source-version-changes.md)
- [03 - Persist Skip Item and item failures](03-persist-skip-item-and-item-failures.md)
