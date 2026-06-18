# Run Destination Helpers Inline And Record Journaled Changes

Status: ready-for-agent

## Parent

[Destination Tracking](../PRD.md)

## What to build

Add the first end-to-end destination helper path for process migrations. Destination capability modules should expose normal Effect helpers, and helpers that complete a trackable destination effect should record a descriptor-backed destination change in the scoped Destination Journal. If a later process step fails, the failed Migration Item State should preserve the process journal segment so partial destination effects can be inspected and used by rollback work later.

Use the in-memory destination capability as the tracer bullet. Rewrite the relevant in-memory command-plan destination tests to inline helper calls and journal assertions instead of keeping parallel command-plan coverage.

## Acceptance criteria

- [ ] A destination capability module can expose a typed Destination Change Descriptor and an Effect helper.
- [ ] Process execution provides a scoped tracking service for the current Migration Definition and Source Item.
- [ ] A successful helper records one schema-valid change entry in the process journal.
- [ ] A helper that fails before completing its destination effect does not record a success change.
- [ ] A helper can be retried inline by the process using normal Effect composition.
- [ ] Repeated entries with the same descriptor preserve typed payloads and journal order.
- [ ] Descriptor predicates narrow decoded journal entries to typed change entries with typed `value`.
- [ ] Failed process state persists earlier successful helper-authored journal entries.
- [ ] Journal entries validate descriptor payloads before persistence, and malformed persisted tracking state fails decoding.
- [ ] Relevant in-memory destination examples/tests are migrated from returned command plans to effectful helper calls.
- [ ] No new command-plan behavior, examples, or tests are added.
- [ ] Existing typecheck and tests pass after the migrated coverage is updated.

## Blocked by

- [Introduce Process Execution And Quarantine Command Plans](./01-introduce-process-execution-and-quarantine-command-plans.md)
