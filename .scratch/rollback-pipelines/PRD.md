# Explicit Rollback Pipelines

Status: ready-for-agent

## Problem Statement

The migration SDK can persist durable migration item state and execute ordered destination command plans, but it has no rollback primitive. Migration authors need a way to compensate destination-side effects such as creating, publishing, stubbing, or partially updating destination items. The SDK should support rollback without forcing destination plugins to model inferred inverse commands or reversible command flags.

Rollback must preserve the user's ability to re-migrate after cleanup. When rollback succeeds, durable migration memory for that item should be removed so the source identity is treated as unmigrated. When rollback fails, the durable item state should remain available so rollback can be retried.

## Solution

Add explicit rollback pipelines as a first-class SDK operation. A migration definition may provide a `rollback` pipeline that receives a rollbackable migration item state and returns a side-effect-only rollback command plan. The runtime selects rollbackable item states from the migration store, executes rollback command plans through the existing destination command machinery, deletes item state immediately after each successful item rollback, and returns a rollback-specific run summary.

Rollback is state-driven, not source-driven. It does not read source items, does not update source cursors, and does not infer inverse commands from the forward destination command plan. Dependency safety is enforced through rollback preflight and reverse dependency ordering, without silently expanding the selected rollback scope.

## User Stories

1. As a migration author, I want to define a rollback pipeline beside my forward pipeline, so that I can author destination-specific compensation logic.

2. As a migration author, I want rollback commands to be ordinary destination commands, so that destination plugins can expose provider-native operations such as unpublish and delete.

3. As a migration author, I want rollback to receive durable migration item state, so that I can use destination identity and destination version without reading the source again.

4. As a migration author, I want rollback input to include the full narrowed item state, so that I can branch on migrated, needs-update, or failed state when compensation differs.

5. As a migration author, I want rollback command factories to accept existing destination identity values ergonomically, so that I do not need to unwrap durable identities manually.

6. As a migration author, I want rollback pipeline errors to remain typed, so that known rollback planning failures are modeled consistently with forward pipeline failures.

7. As a destination plugin author, I want rollback command plans to reject identity-bearing commands, so that rollback cannot create or replace the durable destination identity it is compensating.

8. As a destination plugin author, I want rollback commands to be side-effect-only, so that commands such as unpublish and delete are clearly separate from identity-producing forward commands.

9. As a destination plugin author, I want rollback command handlers to receive the existing destination command context, so that destructive operations can log and inspect run, definition, source identity, source version, and previous state.

10. As a migration operator, I want to rollback all rollbackable states for one migration definition, so that I can clean up destination effects for a definition.

11. As a migration operator, I want to target one or more source identities for rollback in a single-definition operation, so that I can clean up specific migrated items.

12. As a migration operator, I want duplicate targeted source identities to be deduplicated, so that generated or repeated input does not execute rollback twice for the same item.

13. As a migration operator, I want an empty targeted identity list to be rejected, so that an accidental empty selection is not silently treated as rollback-all or no-op.

14. As a migration operator, I want targeted identities with no item state to count as skipped, so that already-rolled-back or never-migrated identities do not fail the request.

15. As a migration operator, I want skipped item states to remain unchanged during rollback, so that rollback does not erase non-destination migration memory.

16. As a migration operator, I want failed item states with destination identity to be rollbackable, so that partial destination side effects can be compensated.

17. As a migration operator, I want failed item states without destination identity to count as skipped, so that the runtime does not attempt compensation without durable destination evidence.

18. As a migration operator, I want needs-update item states with destination identity to be rollbackable, so that destination stubs and incomplete destination items can be cleaned up.

19. As a migration operator, I want rollback to delete item state after each successful item rollback, so that rollback progress survives process crashes.

20. As a migration operator, I want rollback failures to preserve original item state, so that later rollback attempts retain destination identity, version, status, and error evidence.

21. As a migration operator, I want rollback failures to continue processing remaining items, so that a batch rollback can make partial progress.

22. As a migration operator, I want a rollback summary to be marked failed when any item rollback fails, so that partial success is not reported as full success.

23. As a migration operator, I want rollback summaries to use rollback-specific counts, so that rolled back, failed, and skipped items are not confused with migrated, skipped, and unchanged forward counts.

24. As a migration operator, I want rollback summaries to be aggregate-only in the first version, so that returned summaries stay parallel to existing migration summaries.

25. As a migration operator, I want rollback to acquire migration definition locks for selected definitions, so that rollback does not race with forward migration or another rollback for the same selected definition.

26. As a migration operator, I want rollback to fail preflight before durable run creation for invalid requests, so that safety failures do not create noisy run state.

27. As a migration operator, I want rollback to execute selected definitions in reverse dependency order, so that dependents are cleaned up before dependencies.

28. As a migration operator, I want rollback to fail preflight when unselected transitive dependents still have rollbackable state, so that rollback does not silently break downstream migrated content.

29. As a migration operator, I want rollback not to silently expand to dependent definitions, so that destructive scope stays explicit.

30. As a migration operator, I want future force behavior to be possible, so that an explicit caller can bypass dependency safety later when they understand the risk.

31. As a migration operator, I want rollback not to update source cursors, so that rollback stays separate from source rediscovery and re-migration policy.

32. As an SDK user, I want rollback to be a separate public operation from forward migration execution, so that destructive cleanup is not hidden behind a run mode.

33. As an SDK user, I want rollback exports to mirror migration run exports, so that the public API feels consistent.

34. As an SDK user, I want a single-definition rollback helper, so that common rollback usage mirrors the existing single-definition run helper.

35. As an SDK user, I want a multi-definition rollback operation, so that dependency-ordered rollback can use the same definition selection semantics as multi-definition migration runs.

36. As an SDK user, I want rollback request shape to be CLI-ready, so that future CLI commands can expose selected definitions, source identities, and force behavior without changing core semantics.

37. As an SDK maintainer, I want the first rollback slice to reuse current item-state listing and direct lookup, so that rollback implementation does not turn into a store pagination redesign.

38. As an SDK maintainer, I want a dedicated migration store item-state deletion operation, so that successful rollback removes durable migration memory explicitly.

39. As an SDK maintainer, I want distinct rollback runtime errors for request and preflight failures, so that rollback failures are easier to understand and catch.

40. As an SDK maintainer, I want rollback tests to start at the public operation boundary, so that behavior is specified before internal helpers are introduced.

## Implementation Decisions

- Add an optional `rollback` pipeline to migration definitions.

- Model rollback as a separate SDK operation, not as a `Run Mode` of forward migration.

- Provide a single-definition rollback helper and a multi-definition rollback operation that mirrors existing migration run exports.

- Keep identity-targeted rollback on the single-definition helper. Do not add global source identity selection to the multi-definition operation in the first slice.

- In the single-definition helper, omitting source identities means rollback all rollbackable item states for that definition.

- Reject empty source identity selections.

- Deduplicate source identities while preserving first occurrence order.

- Use normal migration definitions for rollback input. Do not introduce a rollback-only definition shape.

- Do not call source cursor reads or source identity lookups during rollback execution.

- Do not mutate or clear source cursors during rollback.

- Define rollbackable migration item state as any migration item state that records a destination identity.

- Pass a narrowed rollbackable item state to the rollback pipeline.

- Pass the full narrowed item state, not only source identity and destination identity.

- Provide a minimal rollback context with definition id and rollback run id.

- Reuse the existing destination plugin, destination command definitions, destination command executor, destination retry strategy, and destination command context.

- Apply destination retry only to destination command execution.

- Require rollback command plans to be non-empty.

- Reject identity-bearing commands in rollback command plans.

- Ignore destination identities or versions returned by rollback command execution for durable item-state purposes.

- Do not allow `Skip Item` or rollback-specific skip outcomes from rollback pipelines in the first slice.

- Treat rollback pipeline failures and destination command execution failures as item-level rollback failures.

- Continue processing remaining items after item-level rollback failures.

- Preserve original item state on rollback failure.

- Do not overwrite item state with rollback error details in the first slice.

- Delete item state immediately after each successful item rollback.

- Add a dedicated migration store operation for deleting item state.

- Use current item-state listing for definition-wide rollback.

- Use direct item-state lookup for identity-targeted rollback.

- Do not add store pagination in this slice.

- Return a separate rollback run summary with rollback-specific aggregate counts.

- Keep rollback summary counts non-durable in the first slice.

- Do not add rollback-specific fields to durable migration run state in this slice.

- Use rollback summary counts `rolledBack`, `failed`, and `skipped`.

- Mark rollback definition and top-level rollback summaries failed when the failed count is greater than zero; no-op rollback definitions still succeed.

- Count non-rollbackable selected item states and targeted identities as skipped.

- For definition-wide rollback, make rolled back plus failed plus skipped equal the selected item states inspected for that definition.

- For targeted rollback, make rolled back plus failed plus skipped equal the deduplicated source identities requested.

- Use distinct rollback runtime errors for public request and preflight failures.

- Treat dependency cycles as preflight failures.

- Treat request validation and dependency safety failures as preflight failures before durable run creation.

- Lock selected rollback definitions before executing rollback commands.

- Do not lock unselected dependent definitions in the first slice.

- Never silently expand rollback scope to dependent definitions.

- Use the transitive dependent closure for dependency preflight.

- Fail preflight when unselected transitive dependents have rollbackable item state.

- Ignore unselected dependents that have no rollbackable item state.

- Require dependent definitions needed for safety checks to be present in the supplied request graph.

- Fail missing dependent definitions only when they affect rollback safety for selected definitions.

- Follow the same same-store boundary as forward multi-definition runs.

- Execute selected rollback definitions in reverse dependency order.

- Do not guarantee item order within one migration definition.

- Add an internal per-definition rollback helper for testable orchestration, but do not expose it publicly.

- Implement rollback SDK-first. There is no CLI in this slice.

- Leave future migration executable grouping out of the first rollback implementation.

- Leave rollback dry-run or planning mode out of scope for the first slice.

## Testing Decisions

- Use TDD for the first rollback slice.

- Favor tests against public behavior: returned summaries, destination command executions, item-state deletion or preservation, lock behavior, dependency preflight, and file-store persistence.

- Start with a public single-definition rollback test that rolls back one migrated item, executes a side-effect-only destination command, deletes item state, and returns a rollback summary.

- Test that failed rollback destination commands preserve item state, increment failed counts, mark summary failed, and continue attempting remaining item states.

- Test that rollback pipeline failures preserve item state and count as failed item rollback.

- Test that rollback rejects empty command plans.

- Test that rollback rejects identity-bearing command plans.

- Test that rollback command execution receives destination command context with rollback run id, source identity, source version when present, and previous state set to the rollbackable item state.

- Test that rollback does not call source cursor reads or source identity lookups.

- Test that rollback does not update or clear source cursor state.

- Test that migrated, needs-update, and failed-with-destination-identity states are rollbackable.

- Test that skipped states, missing targeted states, and failed states without destination identity count as skipped and remain unchanged.

- Test that item state is deleted immediately after each successful rollback.

- Test that destination identities or versions returned by rollback command execution do not update item state.

- Test that source identity selections are rejected when empty and deduplicated when repeated.

- Test that the single-definition helper rolls back all rollbackable states by default.

- Test that identity-targeted single-definition rollback uses direct item-state lookup and counts missing identities as skipped.

- Test that multi-definition rollback uses the same definition selection semantics as multi-definition migration runs.

- Test that selected definitions execute in reverse dependency order.

- Test that unselected transitive dependents with rollbackable item state fail preflight before durable run creation.

- Test that unselected dependents without rollbackable item state do not block rollback.

- Test that missing dependent definitions fail only when needed for rollback safety.

- Test that dependency cycles fail preflight.

- Test that selected rollback definitions are locked and released.

- Test that unselected dependents are inspected but not locked in the first slice.

- Test that a selected forward-only definition with no rollbackable states succeeds as no-op.

- Test that a selected forward-only definition with rollbackable state fails preflight.

- Test that file-store item-state deletion removes the persisted item-state JSON file.

- Reuse current in-memory runtime tests as the primary behavior surface.

- Reuse current file-store tests for persisted item-state deletion.

- Keep tests focused on behavior and durable records rather than private helper implementation.

## Out of Scope

- Adding CLI commands.

- Adding a force option to bypass dependency preflight.

- Adding rollback dry-run or planning mode.

- Adding store pagination or changing the item-state listing contract.

- Adding a terminal rolled-back item state.

- Persisting rollback summary counts or operation kind in durable migration run state.

- Persisting rollback item-level error details.

- Returning item-level rollback error details in rollback summaries.

- Adding rollback-specific skip behavior.

- Adding source reads or migration reference lookup to rollback pipelines.

- Adding per-item dependent reference analysis.

- Adding multi-definition source identity targeting.

- Introducing a rollback-only migration definition shape.

- Refactoring public operations into a migration executable object.

- Implementing real provider plugins for CMS rollback commands.

## Further Notes

- This PRD follows the glossary terms in `CONTEXT.md`, especially Rollback Pipeline, Rollback Command Plan, Rollbackable Migration Item State, Rollback Request, and Rollback Run Summary.

- This PRD records the first implementation slice for the decision in `docs/adr/0003-explicit-state-driven-rollbacks.md`.

- Public API details and examples are captured in `docs/design/rollback-api.md`.

- The core architectural distinction is that rollback compensates durable destination identity state. It does not replay source discovery and does not infer command inverses.

- The main deep module opportunity is rollback command plan validation: non-empty, side-effect-only command plans should be validated independently from item-state selection and summary accounting.

- The second deep module opportunity is rollback selection and dependency preflight: rollbackable-state filtering, transitive dependent checks, and reverse dependency ordering should be testable without executing destination commands.
