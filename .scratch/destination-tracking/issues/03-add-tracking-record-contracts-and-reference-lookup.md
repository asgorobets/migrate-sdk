# Add Tracking Record Contracts And Reference Lookup

Status: ready-for-agent

## Parent

[Destination Tracking](../PRD.md)

## What to build

Add `Tracking.record({ id, schema })` as the optional successful-item contract and `Tracking.setRecord(...)` as the process-scoped staging API. A record-backed process must stage exactly one schema-valid record before a successful item can be persisted. Migration reference lookup should return the schema-validated tracking record for record-backed definitions and reject progress-only definitions by default because they do not expose a durable destination reference surface.

Rewrite identity/reference tests away from singular `destinationIdentity` and into tracking records. This slice should support progress-only process definitions and record-backed process definitions without adding any new command-plan coverage.

## Acceptance criteria

- [ ] A Migration Definition can declare a Tracking Record Contract with stable id and schema.
- [ ] `Tracking.setRecord(...)` stages a record inside the current process execution scope.
- [ ] A successful record-backed process persists exactly one schema-valid tracking record.
- [ ] A successful record-backed process with no staged record records a failed item state with tracking contract details.
- [ ] A process that stages more than one record records a failed item state with tracking contract details.
- [ ] A process that stages a schema-invalid record records a failed item state with validation details.
- [ ] A failed process does not expose its staged record as a successful tracking record contract.
- [ ] Migration contract state includes tracking contract id and tracking record schema fingerprint when declared.
- [ ] Tracking contract drift blocks execution when item state exists.
- [ ] Migration reference lookup returns source identity, item status, and tracking record for record-backed definitions.
- [ ] Migration reference lookup rejects definitions without a tracking record contract by default.
- [ ] Reference lookup examples/tests are migrated away from singular `destinationIdentity`.
- [ ] No new command-plan behavior, examples, or tests are added.
- [ ] Existing typecheck and tests pass after the migrated coverage is updated.

## Blocked by

- [Introduce Process Execution And Quarantine Command Plans](./01-introduce-process-execution-and-quarantine-command-plans.md)
