# Operation history and migration completion

## Status

Accepted

## Decision

New Migration Run State records require `operation`: `run` or `rollback`.
`beginRun` and `queueRun` take a named `MigrationRunStartInput` containing the run
ID, definition IDs, and operation. Persisted reads allow an absent operation
for legacy records; advancing those records preserves unknown intent.
The same intent follows the run into every Migration Definition Run State.
The first queue/begin transition establishes it; later transitions preserve it.
This applies to inline execution and Workflow SDK execution. History records
queued/running/succeeded/failed/cancelled operations, independently of completion.

Migration Definition Completion is a separate durable record in Migration Store:
`definitionId`, `runId`, `completedAt`, and `sourceCursor`. Forward execution
writes it after reaching the end of a source pass. Empty sources qualify.
Failed, skipped, and needs-update items do not prevent completion. Dependency
preflight checks this record, not the latest operation result or item error counts.
Missing references may still cause dependent items to fail and can be retried.

Targeted runs, retry-only runs, source inventory inspection, and stubs do not
independently establish whole-migration completion. An interrupted initial pass
must resume and reach the end before dependencies unlock. Later failed or
cancelled work preserves earlier completion while its item issues and operation
result remain visible. For incremental discovery, completion covers the saved
source checkpoint; it does not promise that the source has no newer data.
No live inventory scan is required during dependency checks.

`recordSourcePassCompletion` records the completed source pass.
`removeRolledBackItem` explicitly records a successful rollback by removing the
tracked item and invalidating both completion and the discovery cursor. This
includes selected-item rollback, orphan rollback, and a rollback that later
fails or is cancelled. Resetting the cursor ensures a later incremental run
rediscovers removed items. A missing item is a no-op and preserves both records;
rollback pipeline failures before removal also preserve them.

SQL performs these three changes in one transaction; in-memory performs them
together. File storage serializes completion and rollback transitions with a
definition projection lock. It invalidates completion and cursor before removing
the item, restoring the prior records if deletion fails. A process crash between
writes may conservatively lose completion, requiring a new source pass, but
cannot leave removed data marked complete or skipped on rerun.
Commercetools Custom Objects likewise invalidate before removal and treat an
already removed shared completion or cursor record as success. An ambiguous
network failure leaves the conservative incomplete state; it cannot safely
restore completion because deletion may have committed remotely.

A forward run with orphan cleanup records source-pass completion when scanning
ends. Removing an orphan invalidates it. Successful completion of that
definition's cleanup with no rollback failures records completion again. A
cancelled or partially failed cleanup after removal remains incomplete. Workflow
execution uses the same rule and includes failures from earlier cleanup pages.

The TUI shows completion separately from the latest operation and item counts.
A removed migration returns to `not run`; remaining entries without completion
show `incomplete`. Activity such as running or cancelling is shown while active.
The CLI has separate completion and last-operation columns.

Historical records without completion remain readable but do not establish
readiness. Neither successful history nor item counts prove that a source pass
finished and was not subsequently rolled back. A new full forward pass
establishes completion; retries alone cannot backfill it.

SQL schema version 3 adds nullable run `operation` and the completion table in
one migration. Existing SQL stores use the explicit schema upgrade workflow,
either through the connected TUI popup or the CLI / SDK plan-and-apply APIs.
The server remains connectable before this upgrade; dashboard reads wait until
the schema is current. No old
history is reclassified or used to fabricate completion. File and Commercetools stores add
separate optional completion records without changing their format versions.
Custom stores must implement `getDefinitionCompletion`,
`recordSourcePassCompletion`, and `removeRolledBackItem`, reset the cursor when
removing a tracked item, and accept explicit operation input for new history.
The shared store conformance scenario exercises these transitions across all
built-in adapters. No new service or separate state store is required.

Run and rollback dialogs use the same numbered execution-plan presentation.
When dependencies are incomplete, the run dialog previews the server-prepared
plan with dependencies included; accepting inclusion prepares it again before
starting. Force still prepares only the operator's selected scope. Rollback
buttons use fixed copy; the displayed plan communicates the affected migrations.
The rollback dialog recommends **Include dependencies**, selected by default.
Its alternative, **Selected only**, prepares with force only when omitted
dependents have tracked items, explaining that their records remain and
references may break. Empty dependents require no force. This decision uses
durable item counts, not completion or the last operation's outcome. Changing
scope refreshes the plan without executing it; one confirmation runs that
reviewed plan. The API retains independent inclusion and force options.
