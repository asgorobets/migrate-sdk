# Remove Command Plans From The Public Runtime Path

Status: ready-for-agent

## Parent

[Destination Tracking](../PRD.md)

## What to build

Finish the command-plan cleanup after the process, helper, tracking record, diagnostics, and rollback paths have replaced the behaviors they covered. Remove command-plan authoring from the public runtime path rather than keeping it as a supported legacy model. Public examples and primary docs should show process pipelines, destination capability helpers, tracking records, diagnostics, lookup, and rollback evidence as the only destination-tracking model.

This is a hard cleanup slice. Any remaining command-plan tests should be deleted or rewritten to the process/helper/tracking model unless they cover a deliberately internal implementation detail that is no longer public API.

## Acceptance criteria

- [ ] Public Migration Definition authoring no longer exposes command-plan `pipeline` as a supported path.
- [ ] Public command-plan examples are removed or rewritten to process/helper/tracking-record APIs.
- [ ] Remaining command-plan tests are deleted or rewritten unless they cover an intentionally internal implementation detail.
- [ ] Public exports expose curated tracking and destination capability APIs without broad internal paths.
- [ ] Runtime item processing uses process completion, journal evidence, and optional tracking record contract evaluation as the destination-tracking model.
- [ ] Singular destination identity inference is no longer required for migrated, failed, needs-update, lookup, or rollback behavior in the new public path.
- [ ] Status and read-only inspection paths do not initialize destination helpers or execute destination effects.
- [ ] Docs use `Process Pipeline`, Destination Journal, Destination Change Descriptor, Destination Journal Diagnostic, Tracking Record, and Tracking Record Contract vocabulary consistently.
- [ ] No new command-plan behavior, examples, or tests are added.
- [ ] Existing typecheck and tests pass after cleanup.

## Blocked by

- [Introduce Process Execution And Quarantine Command Plans](./01-introduce-process-execution-and-quarantine-command-plans.md)
- [Run Destination Helpers Inline And Record Journaled Changes](./02-run-destination-helpers-inline-and-record-journaled-changes.md)
- [Add Tracking Record Contracts And Reference Lookup](./03-add-tracking-record-contracts-and-reference-lookup.md)
- [Persist Explicit Journal Diagnostics](./04-persist-explicit-journal-diagnostics.md)
- [Rollback From Journal And Tracking Evidence](./05-rollback-from-journal-and-tracking-evidence.md)
