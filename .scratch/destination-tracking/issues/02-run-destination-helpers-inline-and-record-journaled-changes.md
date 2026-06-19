# Run Destination Helpers Inline And Record Journaled Changes

Status: done

## Parent

[Destination Tracking](../PRD.md)

## What to build

Add the first end-to-end destination helper path for process migrations. Destination capability modules should expose normal Effect helpers, and helpers that complete a trackable destination effect should record a descriptor-backed destination change in the scoped Destination Journal. If a later process step fails, the failed Migration Item State should preserve the process journal segment so partial destination effects can be inspected and used by rollback work later.

Use the in-memory destination capability as the tracer bullet. Rewrite the relevant in-memory removed destination model destination tests to inline helper calls and journal assertions instead of keeping parallel removed destination model coverage.

## Acceptance criteria

- [x] A destination capability module can expose a typed Destination Change Descriptor and an Effect helper.
- [x] Process execution provides a scoped tracking service for the current Migration Definition and Source Item.
- [x] A successful helper records one schema-valid change entry in the process journal.
- [x] A helper that fails before completing its destination effect does not record a success change.
- [x] A helper can be retried inline by the process using normal Effect composition.
- [x] Repeated entries with the same descriptor preserve typed payloads and journal order.
- [x] Descriptor decoders return typed change entries with decoded typed `value`.
- [x] Process terminal states persist earlier successful helper-authored journal entries.
- [x] Journal entries validate descriptor payloads before persistence, and malformed persisted tracking state fails decoding.
- [x] Relevant in-memory destination examples/tests are migrated from returned removed destination model to effectful helper calls.
- [x] No new removed destination model behavior, examples, or tests are added.
- [x] Existing typecheck and tests pass after the migrated coverage is updated.

## Blocked by

- Issue 01: Introduce Process Execution And Quarantine Removed Destination Models
