# Source-order selection and limited migration runs

## Status

Accepted, 2026-09-11

Supersedes the normal-run backlog priority in the original POC and update-run
specifications, and the backlog recovery assumption in ADR 0009. The original
decision and Drupal comparison are recorded in
[the provenance research](../research/normal-run-order-provenance.md).

## Decision

A normal run selects items through the source iterator. It does not list failed
and needs-update states and fetch them by identity before reading the source.
Stored state determines eligibility when each item is encountered. New, failed,
needs-update, skipped, and changed migrated items can be attempted. An unchanged
migrated item is omitted when its version and version-contract fingerprint match.
Source or tracking validation failures count as attempts too. This preserves the
SDK's existing eligibility rules, including the successful-skip behavior in
ADR 0010; it changes the order of selection.

This follows Drupal's source-driven ordering convention, without adopting all
Drupal eligibility rules. In particular, Drupal does not automatically retry a
row solely because its map status is failed.

Full discovery remains the default. A completed traversal deletes its cursor,
so the next run starts from the beginning. Interrupted traversals retain their
checkpoint. Incremental discovery remains opt-in and retains its checkpoint
after completion. Neither policy fetches earlier failed or needs-update items
outside the iterator. Use `--rescan`, an explicit identity target, or `--failed`
as appropriate to revisit work behind a saved cursor. A later full traversal
also encounters that work. Explicit failed, skipped, and identity-targeted runs
continue to use identity lookup.

`migrate run articles --limit N` and registry run input `{ limit: N }` cap the
number of eligible source-item attempts. N must be a positive safe integer.
Unchanged items do not consume the budget. Migrated, failed, skipped, and
needs-update outcomes do. A failure can therefore be selected again by the next
`--limit 1` run; the option does not promise one successful migration per run.

This version supports one explicitly selected migration, optionally with
`--rescan`. It rejects all/group selection, dependency expansion, update,
targeted retry modes, explicit identity targets, and orphan rollback. The limit
applies to source-item attempts, not the destination operations performed by a
pipeline or reference lookup.

The source still owns page size. The runner schedules no more source items at a
time than the remaining attempt budget, processes them using the configured
concurrency, and continues past unchanged items. Batch pipelines may receive
smaller groups within one source page. Normal source order governs selection;
concurrent pipelines may finish in a different order. A limit does not bound
source reads or source initialization.

A partially processed page never commits its next cursor. The next run rereads
that page and applies ordinary eligibility to its settled prefix. Fully settled
pages can commit their next cursor. Reaching the limit is not proof of source
exhaustion and never clears the full-discovery checkpoint. If the final page is
fully settled, the run can report normal completion even when it exactly used
its budget. No speculative next-page read is required merely to prove exhaustion.

A successful operation stopped by the limit has definition status `succeeded`.
As with targeted `--id` runs, success means the requested work succeeded, not
that the entire source was exhausted. Item failures retain failed status. No
new public status or stop-reason field is required.

Completion follows [ADR 0011](0011-operation-history-and-migration-readiness.md).
Stopping at the limit before source exhaustion does not create or refresh a
Migration Definition Completion record. Earlier completion remains valid,
including after later successful or failed limited work. If rollback removed a
tracked item and invalidated completion, limited work cannot reestablish it
until a source pass reaches its end. Empty sources and fully settled terminal
pages qualify, including when the budget is exactly used or some items failed.
An incremental completion records the completed checkpoint; it does not assert
that the source has no newer items. Reaching a budget on a nonterminal page
does not prove exhaustion, even if the next page would be empty.

Inline and Workflow SDK execution use the same cursor-window logic and
cumulative attempt counts. Workflow cursor-window steps
must continue to disable automatic retries, as their effects and step results
cannot be committed atomically.

CLI/server plans expose the limit, and the server plan fingerprint includes it.
The CLI rejects a prepared operation that omits or changes the requested limit,
including responses from older servers that discard the unsupported option.
Persisted definition status and returned summaries use the existing fields.
The limit adds no storage migration beyond the completion support in ADR 0011.
The runner keeps the limit/exhaustion distinction internal and calls source-pass
completion finalization only after source exhaustion.
