# Implement Run Modes over Migration Item State

Status: ready-for-agent

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Implement normal, failed, skipped, and item Run Modes over durable Migration Item State. Normal mode should process failed and needs-update backlog before cursor discovery. Targeted modes should use SourcePlugin.readByIdentity to reprocess known Source Identities.

## Acceptance criteria

- [ ] Normal Run Mode processes failed backlog before cursor discovery.
- [ ] Normal Run Mode processes needs-update backlog before cursor discovery.
- [ ] Failed Run Mode processes only failed Migration Item States.
- [ ] Skipped Run Mode processes skipped Migration Item States regardless of Source Version.
- [ ] Item Run Mode processes exactly one Source Identity regardless of current state.
- [ ] Targeted modes use SourcePlugin.readByIdentity.
- [ ] Source identity lookup failures for known items can be recorded as item failures.
- [ ] Tests verify normal backlog behavior, failed mode, skipped mode, and item mode.

## Blocked by

- [02 - Process cursor windows and Source Version changes](02-process-cursor-windows-and-source-version-changes.md)
- [03 - Persist Skip Item and item failures](03-persist-skip-item-and-item-failures.md)
