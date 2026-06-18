# Introduce Process Execution And Quarantine Command Plans

Status: ready-for-agent

## Parent

[Destination Tracking](../PRD.md)

## What to build

Introduce `process` as the canonical migration authoring slot and run a progress-only process migration end-to-end while keeping `pipeline` only as temporary scaffolding for tests that have not yet moved. A process definition should process one source item with normal Effect composition, persist durable item progress without destination tracking when no tracking record contract is declared, and keep current run, skip, unchanged, lock, and store-failure behavior intact for the migrated path.

This slice starts the command-plan removal path. It should not add new command-plan behavior, command-plan examples, or command-plan tests. Any example or test touched by this slice should be moved to `process` unless it is explicitly covering the temporary bridge.

## Acceptance criteria

- [ ] Migration definitions can declare `process` as the primary authoring slot.
- [ ] A `process` definition runs one decoded Source Item end-to-end and may return or perform void-like work.
- [ ] A successful `process` definition without a tracking record contract persists source identity, source version, item status, last run, updated time, and normal progress state without destination tracking.
- [ ] Skip Item, failed process, unchanged migrated item, lock behavior, and store-failure behavior continue to work for the process path.
- [ ] `pipeline` / command-plan authoring is marked deprecated or otherwise quarantined as temporary bridge behavior.
- [ ] A definition cannot ambiguously declare both `process` and `pipeline`.
- [ ] Existing examples/tests touched by this slice are migrated to `process`; no new command-plan examples or tests are added.
- [ ] Existing typecheck and tests pass after the migrated coverage is updated.

## Blocked by

None - can start immediately
