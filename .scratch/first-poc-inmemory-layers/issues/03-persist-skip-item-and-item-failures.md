# Persist Skip Item and item failures

Status: done

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Add item outcome handling for Skip Item and item-level failures. A pipeline should be able to yield a public `skipItem(...)` helper, causing skipped Migration Item State to be persisted without executing a Destination Command. Pipeline and destination failures should be normalized into failed Migration Item State while the run continues processing other items.

## Acceptance criteria

- [x] Skip Item is implemented as an Effect-native typed error with a public helper for pipeline authors.
- [x] A skipped Source Item persists skipped Migration Item State with a skip reason.
- [x] The DestinationPlugin is not called when the pipeline skips a Source Item.
- [x] Pipeline failures are normalized into failed Migration Item State.
- [x] DestinationPlugin failures are normalized into failed Migration Item State.
- [x] The runner continues processing remaining Source Items after item-level failures.
- [x] A run with one or more item failures returns a failed Migration Run Summary.
- [x] Tests verify skip behavior, failed item persistence, continue-after-failure behavior, and failed summary status.

## Blocked by

- [01 - Run one Source Item through in-memory runtime](01-run-one-source-item-through-in-memory-runtime.md)
