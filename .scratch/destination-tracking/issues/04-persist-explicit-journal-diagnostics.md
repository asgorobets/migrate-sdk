# Persist Explicit Journal Diagnostics

Status: ready-for-agent

## Parent

[Destination Tracking](../PRD.md)

## What to build

Add explicit durable diagnostics for process and destination-helper failure context. `Tracking.logDiagnostic(...)` should append a generic diagnostic entry with required severity, required message, and optional JSON-object details to the scoped Destination Journal. Destination helpers may use the same path internally when a failed operation needs durable context, but ordinary Effect logs and Console output must not become durable item-state evidence.

Update failure examples/tests so durable diagnostics are inspected through failed Migration Item State journal evidence, not command-plan errors.

## Acceptance criteria

- [ ] `Tracking.logDiagnostic(...)` accepts required severity and message plus optional JSON-object details.
- [ ] Valid diagnostic entries append to the scoped process journal.
- [ ] Missing or invalid diagnostic severity is rejected before persistence.
- [ ] Destination helpers can record a diagnostic on failure without recording a success change.
- [ ] Process-authored diagnostics recorded before failure persist in failed item state.
- [ ] Durable diagnostic append still happens when Effect log-level configuration would suppress the corresponding observability log event.
- [ ] Ordinary `Effect.log*` and `Console.*` output is not persisted as a Destination Journal Diagnostic.
- [ ] Diagnostic entries do not require stable ids or descriptor-backed detail schemas.
- [ ] Failure examples/tests are migrated to inspect failed item state journal diagnostics.
- [ ] No new command-plan behavior, examples, or tests are added.
- [ ] Existing typecheck and tests pass after the migrated coverage is updated.

## Blocked by

- [Run Destination Helpers Inline And Record Journaled Changes](./02-run-destination-helpers-inline-and-record-journaled-changes.md)
