# Run Update Rescan

Status: ready-for-agent

## Problem Statement

Migration operators need a way to rerun a migration definition after process pipeline code, destination helper behavior, or destination-side mapping decisions change, even when the source system has not changed the observed Source Version for each Source Item.

Today a normal run resumes from the stored Source Cursor and skips previously migrated Source Items when the current Source Version matches the stored Migration Item State. Clearing the Source Cursor alone can rediscover Source Items, but the unchanged gate still prevents the Process Pipeline from running for already migrated items. Rolling back is the wrong tool for this problem because rollback is a compensation workflow that may delete destination data before deleting migration memory.

Operators need a Drupal-like update run: intentionally rescan the source, schedule already migrated items for reprocessing, preserve destination tracking evidence, and allow future normal runs to complete the update work if the update run is interrupted.

## Solution

Add `--update` to the run command and the matching SDK/registry run inputs. `--update` is not a new Run Mode. Run Mode continues to describe source selection such as normal, failed, skipped, or item targeting. `--update` is a run execution option that prepares existing Migration Item State and changes the processing policy for the run.

An update run will:

- acquire the normal Migration Definition lock and pass normal run preflight before mutating state;
- convert existing migrated Migration Item States for each selected Migration Definition into Needs Update state;
- preserve Source Identity, Source Version, source version contract metadata, Tracking Record, and Destination Journal evidence while scheduling the item for update;
- record a reason that the Needs Update state was scheduled by an update run;
- clear the Source Cursor for each selected Migration Definition;
- scan the source from the beginning;
- run the Process Pipeline for scheduled items even when the Source Version matches;
- process new Source Items as normal inserts;
- leave unmatched scheduled items as durable Needs Update backlog for a later run.

The operator-facing behavior is:

- `migrate run articles` resumes from the Source Cursor and skips unchanged migrated items.
- `migrate run articles --update` resets the Source Cursor, schedules migrated items for update, and reruns the Process Pipeline for discovered scheduled items.
- If `migrate run articles --update` is interrupted, a later `migrate run articles` continues processing remaining Needs Update backlog without requiring the operator to remember the original `--update` flag.

The Process Pipeline already receives previous Migration Item State through process context. Update-aware migrations use that previous state, especially Tracking Record and Destination Journal evidence, to choose create, update, patch, upsert, no-op, or provider-specific recovery behavior.

## User Stories

1. As a migration operator, I want to run a Migration Definition with `--update`, so that I can rerun migration logic after process pipeline or destination helper behavior changes.

2. As a migration operator, I want `--update` to restart source discovery from the beginning, so that Source Items behind the current Source Cursor are considered again.

3. As a migration operator, I want `--update` to process previously migrated Source Items even when their Source Version has not changed, so that code-only migration changes can be applied.

4. As a migration operator, I want update intent to survive interruption, so that a later normal run continues the remaining update work.

5. As a migration operator, I want `--update` to preserve destination tracking evidence, so that update-aware process code can locate and modify destination records created by previous runs.

6. As a migration operator, I want `--update` to process newly discovered Source Items in the same run, so that a full update pass handles both inserts and updates.

7. As a migration operator, I want missing Source Items that were scheduled for update to remain visible as pending work, so that source disappearance is not silently treated as successful deletion.

8. As a migration operator, I want `--update` to be separate from rollback, so that rerunning migration code does not imply destructive destination cleanup.

9. As a migration operator, I want `--update` to be rejected with targeted retry flags, so that full-rescan updates do not mix with failed, skipped, or single-item recovery commands.

10. As a migration operator, I want run plans and summaries to make update intent visible, so that I can see when a run will schedule previously migrated state for reprocessing.

11. As a migration author, I want process context during update to include previous Migration Item State, so that I can decide whether to create, update, patch, upsert, or no-op.

12. As a migration author, I want previous Tracking Record and Destination Journal evidence available during update, so that update logic can use durable destination references instead of guessing.

13. As an SDK user, I want the same update behavior through programmatic run inputs, so that application code and the CLI share one operation model.

14. As a CLI user, I want `--update` to work with explicit definitions, all-registry selection, and dependency expansion, so that I can choose the update scope deliberately.

## Implementation Decisions

- Do not add a new Run Mode for update. Run Mode remains the source selection mechanism. Update is an execution option that controls preparation, cursor reset, and unchanged processing.

- Add an update flag to run input contracts used by raw SDK runs, registry-backed runs, planning, and CLI command parsing.

- Make CLI `--update` imply Source Cursor reset. Do not require a separate cursor reset flag for this PRD.

- Reject `--update` with failed mode, skipped mode, and source identity targeting in the first slice.

- Allow `--update` with explicit definitions, all-registry selection, and required dependency expansion.

- Keep plan mode static. A plan with update requested should show that update would be used, but it must not acquire locks, read stores, mutate item state, clear cursors, or scan sources.

- Add an update preparation module that converts migrated Migration Item States to Needs Update state and clears the Source Cursor for the Migration Definition.

- Update preparation must preserve source identity, source version, source version contract metadata, tracking record, and destination journal evidence.

- Update preparation must record a clear reason that the item was scheduled by an update run.

- Update preparation must be idempotent. Migrated states become Needs Update. Existing Needs Update, failed, and skipped states are left as their current status unless a later implementation decision broadens this behavior.

- Update preparation should run after locks are acquired and normal run preflight has succeeded, before any source cursor read begins.

- Store errors during update preparation fail the run. Any already-scheduled Needs Update states remain conservative durable state and can be resumed by a later normal run.

- Normal run behavior continues to process failed and Needs Update backlog before cursor discovery.

- Update run behavior should prefer cursor-first discovery after scheduling states and clearing the Source Cursor. This avoids forcing scan-oriented sources to perform one source identity lookup per migrated item during the initial update run.

- During cursor discovery, a Source Item with previous Needs Update state must run the Process Pipeline even when Source Version matches.

- During update cursor discovery, a Source Item with previous migrated state must also run the Process Pipeline if it was not converted for any reason.

- Source Items not encountered during update cursor discovery remain in their durable state. Scheduled items not found by the reset scan remain Needs Update for later inspection or retry.

- Future normal runs can process remaining Needs Update backlog through the existing source identity lookup path.

- Failed or skipped outcomes from an update attempt must not discard prior tracking evidence. The runtime must preserve enough Tracking Record and Destination Journal evidence for later retry or rollback.

- Successful update processing replaces the prior state with a fresh migrated Migration Item State, fresh Source Version metadata, fresh journal evidence when recorded, and fresh Tracking Record when required by the migration definition.

- The Process Pipeline continues to receive previous Migration Item State in process context. Update-aware code should branch on previous migrated or Needs Update states when deciding whether to create, update, patch, or upsert destination data.

- Destination capability modules are not required to expose a universal update operation. Each destination helper decides whether it supports create, update, patch, upsert, or another provider-native operation.

- Migration authors remain responsible for making update process code idempotent or explicitly update-aware. The framework schedules reprocessing and preserves evidence; it does not infer arbitrary destination update semantics.

- Needs Update becomes a durable queue state meaning that tracked destination state exists and the Source Item must be processed again. Incomplete stubs remain one producer of Needs Update state, and update scheduling becomes another.

- Do not automatically fingerprint process function bodies or destination helper code in this PRD. Pipeline change detection is operator-driven through `--update`. A future explicit process version or pipeline fingerprint can build on the same Needs Update scheduling mechanism.

- Do not introduce automatic destination deletion for source items missing during update. Source disappearance handling remains a separate delete/prune design.

## Testing Decisions

- Tests should assert external behavior: command validation, planned update intent, durable state transitions, cursor reset, source traversal behavior, process invocation, and preservation of tracking evidence.

- Avoid tests that assert private helper call order unless the order is part of the public behavior, such as plan mode not mutating state or update execution clearing the Source Cursor before source discovery.

- Add unit-level tests for the update preparation module. These should cover migrated-to-needs-update conversion, preservation of tracking record and journal evidence, idempotency, reason recording, and non-mutating treatment of failed, skipped, and already Needs Update states.

- Add runtime tests for update execution over in-memory stores and sources. These should cover a migrated item with matching Source Version being processed during update, where the same item would be unchanged during a normal run.

- Add runtime tests proving `--update` clears the Source Cursor and starts cursor discovery from the beginning.

- Add runtime tests proving interrupted update intent is durable: after preparation or partial processing, a later normal run still processes remaining Needs Update item states.

- Add runtime tests for scan-oriented source behavior. The initial update run should use cursor discovery rather than draining every scheduled update item through source identity lookup before scanning.

- Add runtime tests for direct lookup recovery behavior. Remaining Needs Update backlog after an interrupted update run should still be processable by a later normal run.

- Add runtime tests proving previous tracking evidence is available to the Process Pipeline through previous Migration Item State during update.

- Add runtime tests proving failed update attempts preserve prior tracking evidence and destination journal evidence needed for retry or rollback.

- Add CLI parser and command tests for `run --update`, including rejection with failed mode, skipped mode, and source identity targeting.

- Add registry planning tests proving update selection is represented in run plans without reading stores or sources.

- Add CLI render tests proving update plans and missing dependency suggestions preserve the update flag where relevant.

- Reuse existing runtime tests for normal unchanged behavior, failed and skipped run modes, item mode, Source Cursor clearing, and Needs Update backlog processing as prior art.

- Reuse existing CLI tests for run modes, source identity targeting, dependency expansion, plan rendering, and command validation as prior art.

## Out of Scope

- A separate `--from-start` or source-cursor-only reset flag.

- Automatic process function fingerprinting or build-derived pipeline fingerprints.

- Automatic detection that migration code changed.

- Automatic destination update semantics for arbitrary process code.

- A universal destination helper contract that forces all providers to expose the same insert/update/upsert shape.

- Destination deletion or pruning for source items missing during the reset scan.

- Store-level transactions across all item states and cursor deletion.

- A new terminal Migration Item State status distinct from Needs Update.

- Changes to rollback semantics beyond preserving the evidence needed to make update failures rollbackable.

- Changes to source identity contracts, tracking record contracts, or migration contract drift behavior.

## Further Notes

This design intentionally follows the durable part of Drupal Migrate's update behavior: update intent is materialized in item state before processing rather than being a transient runtime flag only. The SDK adapts that idea to the existing Migration Item State model by using Needs Update as the queue state and preserving Tracking Record and Destination Journal evidence for update-aware process code.

The main implementation risk is evidence loss on failed update attempts. If a previously migrated item is scheduled for update and the update attempt fails, the runtime must not leave the user without the prior Tracking Record or journal evidence needed to retry safely or roll back.

The second implementation risk is inefficient lookup behavior for scan-oriented sources. The initial update run should use reset cursor discovery to process scheduled items in one source traversal. Source identity lookup remains the recovery path for remaining Needs Update backlog after interruption.
