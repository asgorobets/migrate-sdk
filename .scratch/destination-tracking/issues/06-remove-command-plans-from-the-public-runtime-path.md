# Remove Removed Destination Models From The Public Runtime Path

Status: ready-for-human

## Parent

[Destination Tracking](../PRD.md)

## What to build

Finish the removed destination model cleanup after the process, helper, tracking record, diagnostics, and rollback paths have replaced the behaviors they covered. Remove removed destination model authoring from the public runtime path rather than keeping it as a supported legacy model. Public examples and primary docs should show process pipelines, destination capability helpers, tracking records, diagnostics, lookup, and rollback evidence as the only destination-tracking model.

This is a hard cleanup slice. Any remaining removed destination model tests should be deleted or rewritten to the process/helper/tracking model unless they cover a deliberately internal implementation detail that is no longer public API.

## Acceptance criteria

- [x] Public Migration Definition authoring no longer exposes removed destination model `pipeline` as a supported path.
- [x] Public removed destination model examples are removed or rewritten to process/helper/tracking-record APIs.
- [x] Remaining removed destination model tests are deleted or rewritten unless they cover an intentionally internal implementation detail.
- [x] Public exports expose curated tracking and destination capability APIs without broad internal paths.
- [x] Runtime item processing uses process completion, journal evidence, and optional tracking record contract evaluation as the destination-tracking model.
- [x] Singular destination identity inference is no longer required for migrated, failed, needs-update, lookup, or rollback behavior in the new public path.
- [x] Status and read-only inspection paths do not initialize destination helpers or execute destination effects.
- [x] Docs use `Process Pipeline`, Destination Journal, Destination Change Descriptor, Destination Journal Diagnostic, Tracking Record, and Tracking Record Contract vocabulary consistently.
- [x] No new removed destination model behavior, examples, or tests are added.
- [x] Existing typecheck and tests pass after cleanup.

## Blocked by

- Issue 01: Introduce Process Execution And Quarantine Removed Destination Models
- [Run Destination Helpers Inline And Record Journaled Changes](./02-run-destination-helpers-inline-and-record-journaled-changes.md)
- [Add Tracking Record Contracts And Reference Lookup](./03-add-tracking-record-contracts-and-reference-lookup.md)
- [Persist Explicit Journal Diagnostics](./04-persist-explicit-journal-diagnostics.md)
- [Rollback From Journal And Tracking Evidence](./05-rollback-from-journal-and-tracking-evidence.md)
