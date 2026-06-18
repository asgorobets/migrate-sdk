# Destination Tracking

Status: ready-for-agent

## Problem Statement

The SDK still persists destination progress through the older command-plan
model, where a process pipeline returns destination commands and the
runtime infers one primary destination identity from command results. That model
breaks down for migrations where one source item affects several destination
resources, such as a product plus inventory, a business unit plus addresses, or
a CMS entry plus assets. It also puts tracking policy in the wrong place:
destination plugins know how to perform destination-native operations, but the
migration definition should decide what durable destination tracking is useful
for rollback, reference lookup, inspection, and later reruns.

The source identity foundation is now in place. Destination-side tracking needs
the matching runtime model from the accepted scoped process tracking decision:
destination helpers run inline inside the process pipeline, successful
destination effects record typed destination changes in a scoped journal,
failed or suspicious operations may record serializable journal diagnostics, and
the migration definition may declare a schema-validated materialized tracking
record as the successful item contract. When no tracking record contract is
declared, successful items still persist migration progress without durable
destination tracking. The scoped journal exists as runtime evidence and may be
persisted for failed items when partial destination effects or diagnostics
happened before failure.

## Solution

Add destination tracking as a first-class runtime capability built around
destination journals, typed destination change descriptors, and optional
tracking record contracts.

Migration definitions may declare a tracking record contract. A definition with
a tracking record contract must stage exactly one schema-valid tracking record
before a successful item can be persisted. A definition without a tracking record
contract persists item progress without durable destination tracking on success.
Progress-only does not mean ephemeral: item state, source identity, source
version, and failures are still durable.

Destination capability modules will expose normal Effect helpers instead of
requiring pipelines to return command plans. Helpers that produce trackable
destination effects record destination-native changes into the framework-owned
destination journal when they succeed. Migration authors can still use ordinary
hand-written Effects, but those Effects do not record destination-native
changes unless they are wrapped in a destination helper.
Process pipeline code can also record explicitly marked journal diagnostics when durable
failure context would otherwise only exist in ordinary logs.

The runtime will execute each source item in a scoped process execution scope,
provide a process-facing tracking service backed by the scoped journal and
staged tracking-record state, snapshot the journal on failure when useful
evidence exists, evaluate the optional tracking record contract at the
successful item boundary, and then persist migrated or failed migration item
state through the runtime-owned migration store path. This replaces singular
destination identity inference as the target model for new work.

## User Stories

1. As a migration author, I want a migration definition to optionally declare a tracking record contract, so that durable destination references are a migration-owned choice.

2. As a migration author, I want definitions without a tracking record contract to still persist item progress, so that simple or side-effect-only migrations do not need destination tracking boilerplate.

3. As a migration author, I want record-backed migrations to provide a stable, schema-validated reference contract, so that downstream migrations can depend on durable fields.

4. As a migration author, I want successful progress-only items not to look rollbackable through destination tracking, so that destructive cleanup scope stays explicit.

5. As a migration author, I want progress-only migrations to still record item state, so that skipped, failed, migrated, and unchanged behavior remains durable.

6. As a migration author, I want destination helpers to run inline in my Effect process, so that destination work, branching, retries, and error handling use normal Effect composition.

7. As a migration author, I want to retry a specific destination helper call, so that retry policy is applied exactly where the destination effect is safe to retry.

8. As a migration author, I want successful destination helpers to record destination-native changes automatically, so that baseline tracking does not require wrapper code at every call site.

9. As a migration author, I want failed helper calls not to record success changes, so that the journal reflects only destination effects that actually happened.

10. As a migration author, I want failed helper calls to be able to record serializable diagnostics, so that durable failed item state can explain destination failures even when logs are unavailable or unstructured.

11. As a migration author, I want a failed process pipeline to preserve earlier successful destination changes, so that partial destination side effects can be inspected and rolled back.

12. As a migration author, I want to stage a tracking record from inside the process pipeline, so that the runtime can commit it only when the item succeeds.

13. As a migration author, I want to map domain-specific failures into generic journal diagnostics from inside the process pipeline, so that failure context can be durable without becoming a destination change.

14. As a migration author, I want a tracking record contract to fail the item when no record is staged, so that incomplete declared tracking state is not silently persisted.

15. As a migration author, I want a tracking record contract to fail the item when the staged record does not match its schema, so that downstream reference lookup stays type-safe.

16. As a migration author, I want multiple staged records to fail the item in this slice, so that ambiguous tracking records are surfaced explicitly.

17. As a migration author, I want a materialized tracking record to be optional, so that migrations without downstream reference needs can remain progress-only.

18. As a migration author, I want a tracking record to be able to model multiple destination resources, so that one source item can track a product, inventory entry, and related references together.

19. As a migration author, I want destination-change journal entries to come from destination helpers, so that change recording stays destination-owned in this slice.

20. As a migration author, I want repeated journal entries to keep typed payloads and order, so that rollback code can distinguish same-descriptor changes without a second labeling API.

21. As a migration author, I want journal reads to use typed change descriptors, so that I do not rely on raw change kind strings.

22. As a migration author, I want migration reference lookup for record-backed definitions to return the tracking record, so that downstream migrations can read stable fields.

23. As a migration author, I want migration reference lookup to reject definitions without a tracking record contract by default, so that missing durable destination references are explicit.

24. As a migration author, I want the journal available on failed item state when partial destination effects or diagnostics happened, so that rollback and inspection can understand what occurred before failure.

25. As a migration author, I want a tracking record contract id, so that changing the public lookup shape requires an intentional compatibility decision.

26. As a migration author, I want tracking contract changes to block execution when item state exists, so that existing durable state is not reused under incompatible destination tracking semantics.

27. As a migration author, I want source version changes to remain item comparability metadata, so that changing version semantics causes reprocessing without becoming a hard migration contract blocker.

28. As a plugin author, I want to expose a destination capability module with helper methods, change descriptors, dependency layers, and optional rollback helpers, so that destination-specific behavior stays cohesive.

29. As a plugin author, I want destination helpers to be schema-backed, so that request and returned change shapes are validated at the destination boundary.

30. As a plugin author, I want helpers to record changes and diagnostics through the framework-provided tracking service, so that plugins do not own migration tracking policy.

31. As a plugin author, I want change descriptors to be stable public API, so that migration code references exported descriptors instead of raw strings.

32. As a plugin author, I want change descriptors to carry enough schema metadata for validation and fingerprinting, so that a destination registry is not required in this slice.

33. As a plugin author, I want plugin-local provision to remain the recommended dependency style, so that migration authors can configure destination clients once and use the returned helper module directly.

34. As a plugin author, I want process-level and run-level provision to remain possible advanced Effect usage, so that unusual dependency composition is not blocked.

35. As a runtime maintainer, I want a scoped tracking service, so that journal entries and staged records are isolated to one source item or rollbackable item state.

36. As a runtime maintainer, I want process and rollback pipelines to capture journal entries in separate scoped tracking services, so that live destination evidence is not mixed across pipeline executions.

37. As a runtime maintainer, I want item state to persist the process journal segment separately from failed rollback attempt segments, so that rollback retries can distinguish original migration evidence from earlier rollback-attempt evidence.

38. As a runtime maintainer, I want tracking record contract evaluation to be a deep module, so that record staging and validation can be tested without running source discovery.

39. As a runtime maintainer, I want migration item state to preserve structured source identity and any durable destination tracking state, so that status, lookup, rollback, and inspection do not depend on reparsing display strings.

40. As a runtime maintainer, I want failed item state to preserve destination journal evidence when destination effects or diagnostics happened before failure, so that rollback and diagnostics can see partial work.

41. As a runtime maintainer, I want successful item state without a tracking record contract to persist progress and any recorded process journal evidence, so that lightweight progress-only migrations and journaled destination effects are both represented accurately.

42. As a runtime maintainer, I want successful item state with a tracking record contract to persist the schema-valid record and any recorded process journal evidence, so that lookup can expose the public record without discarding execution evidence.

43. As a runtime maintainer, I want successful items with no tracking record and no journal entries to remain progress-only, so that state does not look rollbackable by accident.

44. As a runtime maintainer, I want a migration contract to include tracking contract id and tracking record schema fingerprint when declared, so that tracking drift is detected before source reads begin.

45. As a runtime maintainer, I want helper-authored changes and generic diagnostics to participate in journal serialization, so that destination evidence survives durable persistence across terminal outcomes.

46. As a runtime maintainer, I want destination journal entries to be schema-validated before persistence, so that malformed helper output cannot corrupt the migration store.

47. As a runtime maintainer, I want old command-plan destination identity inference treated as legacy, so that new implementation work does not deepen the single-identity model.

48. As a runtime maintainer, I want the first in-memory destination capability module to prove the new helper API, so that runtime semantics are verified before provider-specific integrations.

49. As a runtime maintainer, I want the old in-memory destination command-plan tests either migrated or explicitly left as legacy coverage, so that the target model is visible in tests.

50. As a store implementer, I want durable schemas for journal entries and tracking records, so that file, in-memory, and later SQL stores can validate stored state consistently.

51. As a store implementer, I want malformed persisted destination tracking state to fail decoding, so that corrupt tracking data is not silently accepted.

52. As a status consumer, I want status to keep avoiding destination initialization, so that read-only inspection cannot accidentally execute destination-side work.

53. As a rollback author, I want rollbackable item state to be based on durable destination tracking evidence and optional tracking records, so that my rollback effect can decide how to compensate composite destination effects.

54. As a rollback author, I want rollback pipelines to receive decoded ordered process journal entries and narrow them with destination change descriptors, so that compensation code does not parse raw persisted records.

55. As a rollback author, I want failed rollback attempt journal segments to be available separately from process journal entries, so that retry and manual correction logic can account for previous compensation attempts.

56. As a rollback author, I want successful progress-only items not to be rollbackable through destination tracking, so that destructive cleanup scope is explicit.

57. As an SDK maintainer, I want this destination tracking slice to keep serializable migration specs out of scope, so that executable TypeScript migration definitions remain the first implementation path.

58. As an SDK maintainer, I want the public API to use domain terms from the glossary, so that destination tracking does not reintroduce ambiguous phrases such as destination identity for composite state.

59. As an SDK maintainer, I want all new public examples to use the scoped process model, so that docs do not teach the deprecated command-plan identity path.

## Implementation Decisions

- Build this as the destination-side implementation of the accepted scoped process tracking decision.

- Treat the source identity contract work as a prerequisite that is already available.

- Use `Destination Change`, `Destination Change Descriptor`, `Destination Journal`, `Destination Journal Diagnostic`, `Tracking Record`, `Tracking Record Contract`, and `Destination Capability Module` as the public vocabulary.

- Keep `Destination Command` and command groups as legacy command-plan concepts and rollback-operation concepts where still needed, but do not use identity-bearing command results as the target tracking model for new work.

- Add a destination change descriptor module as a deep module. It should own descriptor construction, descriptor identity, schema validation, schema fingerprinting inputs, and typed value inference.

- Destination change descriptor ids are stable public API. Migration authors reference exported descriptors from destination capability modules, not raw change kind strings.

- Do not add a destination registry in this slice. Descriptors carry enough metadata for validation, durable serialization, journal reads, and migration contract fingerprinting.

- Add a destination journal module as a deep module. It should own change recording, explicitly marked generic diagnostic recording, process and rollback-attempt segment snapshotting, schema validation, serialization shape, decoded ordered entries, and descriptor predicate narrowing.

- Model each journal entry as either a change entry or a diagnostic entry. A change entry contains one destination change value plus its descriptor identity and runtime metadata. A diagnostic entry uses one generic serializable message shape for failure or inspection context without claiming that a destination change happened.

- Diagnostic entries require `severity` and `message`. Severity values are `info`, `warning`, or `error`. The helper maps that severity to the corresponding Effect log level when emitting the marked log event.

- Diagnostic entries do not require stable ids or descriptor-backed detail schemas in this slice. Their details are a generic JSON object mapped by process code or destination helpers, not the existing validation-oriented `MigrationItemErrorDetail[]` shape.

- Diagnostic entries are created only by `Tracking.logDiagnostic(...)` or destination helpers that use the same helper internally. The helper may emit SDK-marked Effect log events for observability, but ordinary `Effect.log*` and `Console.*` output does not become durable item-state evidence.

- `Tracking.logDiagnostic(...)` appends to the durable item journal even when Effect's configured minimum log level would suppress the corresponding observability log event.

- Do not expose the SDK-owned diagnostic log marker as public API in this slice.

- The scoped destination journal and staged tracking record are framework-owned runtime state exposed through a process-facing tracking service. A simple Ref-backed service is the expected first implementation shape.

- The tracking service is scoped to one migration definition and one item execution. It may be built from runtime context that eventually writes to the migration store, but process code does not receive arbitrary migration-store writes through this API.

- Add a tracking record module as a deep module. It should own tracking record contract construction, staged tracking record behavior, record validation, and success-gate evaluation.

- Definitions without a tracking record contract persist successful item progress and any non-empty process journal segment.

- Successful progress-only items with no journal entries remain lightweight and do not persist destination journal segments.

- Definitions with a tracking record contract require exactly one staged schema-valid tracking record before successful item state can be persisted.

- Tracking record contracts are recommended when successful items need a stable user-shaped contract for downstream lookup, rollback input, or inspection.

- Failed helpers must not record a success change unless the helper knows the destination effect completed.

- Failed helpers may record explicitly marked destination journal diagnostics with normalized serializable JSON-object details.

- Durable journal diagnostics do not persist raw Effect causes, raw thrown objects, or provider response objects that are not stable serialized data.

- Terminal item states may persist process journal segments when destination changes or diagnostics were recorded, because durable evidence is needed for diagnostics and rollback analysis.

- Failed item state does not expose a staged tracking record as a successful item contract. Rollback over partial failures reads durable journal evidence and any existing item-state metadata.

- `Tracking.setRecord` stages one record inside the process execution scope.

- If a successful process with a tracking record contract stages no record, the runtime persists a failed item state with a tracking contract error.

- If a successful process with a tracking record contract stages more than one record, the runtime persists a failed item state with a tracking contract error. This slice does not use last-write-wins.

- If the staged record fails the declared schema, the runtime persists a failed item state with durable validation details.

- Add generic destination journal diagnostics for migration-owned failure context. The expected implementation shape is a scoped tracking service that appends explicit diagnostics to the item journal and may emit SDK-marked Effect log events while merging with existing loggers.

- Repeated entries with the same descriptor are distinguished by typed change payloads and journal order, not by a public labeling API.

- Extend migration item state to store a process journal segment, failed rollback-attempt journal segments, and optional tracking records.

- Continue storing source identity, source version, source version contract fingerprint, item status, updated time, and failure details.

- Replace migrated and needs-update state requirements for a singular destination identity with optional tracking-record durable state.

- Keep backward compatibility concerns isolated. Existing pre-tracking state that contains a singular destination identity can be treated as legacy command-plan state until an explicit migration or removal decision is made.

- Extend migration contract state to include tracking contract id and tracking record schema fingerprint when a tracking record contract is declared.

- Source identity contract mismatches remain hard blockers when any item state exists.

- Tracking record contract mismatches are hard blockers when any item state exists.

- Source version contract fingerprint changes remain comparability metadata and should not be promoted into a hard blocker by this PRD.

- Change descriptor schema changes do not affect the successful tracking record contract unless the declared tracking record schema depends on those descriptor values directly.

- Update migration definition authoring so new definitions declare source, store, optional tracking record contract, dependencies, and an Effect process.

- New effectful-process definitions should not require a top-level destination property solely for runtime execution.

- New destination-tracking implementation work should rename the public authoring slot from `pipeline` to `process`.

- The process pipeline should return or perform `void`-like work in the target path. Durable item outcome is derived by the runtime from process exit, failed-state journal evidence, and optional tracking record contract evaluation.

- Preserve Skip Item as a typed process error that records skipped item state and does not require destination tracking.

- Destination helpers are ordinary Effect values that may require destination services and the framework-provided tracking service.

- Plugin-local `.provide(...)` is the recommended destination capability dependency style.

- Process-local and run-level Effect provision remain advanced usage where type requirements can still be represented.

- Add an in-memory destination capability module as the tracer bullet for effectful helpers and automatic change recording.

- Do not make a provider-specific destination integration the first proof of the runtime contract.

- Keep first-party destination capability modules in the main SDK package unless a real platform or dependency boundary justifies a separate package.

- Expose public tracking and destination capability APIs from curated root or focused subpath exports. Do not expose broad internal paths.

- Update migration reference lookup so lookup result shape follows the optional tracking record contract.

- Record-backed lookup returns source identity, item status, and the schema-validated tracking record.

- Definitions without a tracking record contract are rejected by lookup by default because there is no durable destination reference surface.

- Update rollbackability to mean item state with durable destination tracking evidence that can be passed to the user-authored rollback effect, not item state with a singular destination identity and not runtime proof that compensation is required.

- The rollback effect owns journal interpretation. It may use process destination changes, previous failed rollback-attempt segments, tracking records, current item status, and provider helpers to compensate, no-op, or fail for manual correction.

- When the rollback effect succeeds for a selected item state, the runtime removes that item state. When the rollback effect fails, the runtime preserves the original item state and appends a failed rollback-attempt journal segment so rollback can be retried or manually corrected.

- Rollback pipeline redesign over journal and record state is part of the destination tracking architecture, but provider-specific rollback helper APIs can be implemented after the core journal and lookup surfaces land.

- Status remains read-only and must not initialize destination capability modules, execute pipelines, or inspect live destination systems.

- Keep CLI execution and registry behavior mostly unchanged in this PRD. Registry plans select definitions; runtime tracking semantics determine item state once execution begins.

- Do not use Effect PubSub as the canonical tracking mechanism. Optional observability can be added later, but durable per-item tracking comes from the scoped runtime tracking service and journal.

- Do not add a serializable Migration Spec compiler or Plugin Registry in this PRD.

## Testing Decisions

- Use tests that assert public behavior and durable records rather than private helper internals.

- Add focused tests for the destination change descriptor module: descriptor identity, schema validation, malformed value failures, and typed entry predicates.

- Add focused tests for the destination journal module: helper-authored change recording, repeated same-descriptor entries with stable order, explicitly marked generic diagnostic recording with required severity and JSON-object details, process and rollback-attempt segment snapshotting, schema validation, and decoded ordered entries.

- Add schema tests proving missing or invalid diagnostic severity is rejected before persistence.

- Add focused tests for tracking record evaluation: progress-only success, record-backed success, missing record failure, duplicate staged record failure, schema failure, and failed-process segment behavior.

- Add migration contract tests for tracking record contract drift with existing item state.

- Reuse the existing runtime integration test style for one migrated item, failed item continuation, Skip Item behavior, unchanged behavior, run summaries, lock behavior, and store failure behavior.

- Add in-memory integration tests where a helper records a destination change, a later step fails, and failed item state persists that journal evidence.

- Add in-memory integration tests where a helper fails, records a diagnostic, records no success change, and failed item state persists the diagnostic evidence.

- Add integration tests where process code records a diagnostic through `Tracking.logDiagnostic(...)` before failing, and failed item state preserves that diagnostic.

- Add integration tests proving `Tracking.logDiagnostic(...)` persists the diagnostic journal entry even when Effect log-level configuration would suppress the corresponding observability log event.

- Add tests proving the SDK-owned diagnostic log marker is not exported as public API.

- Add integration tests proving ordinary logs inside item execution are not persisted as destination journal diagnostics.

- Add in-memory integration tests where a process stages a tracking record and a record-backed migration persists the record.

- Add integration tests where a helper succeeds, a later process step fails, and failed item state preserves the earlier journal entry.

- Add integration tests where a record-backed process stages a record and then fails, proving the failed state preserves journal evidence but not a successful tracking record contract.

- Add integration tests where rollback records a destination change and then fails, proving the original process journal segment is preserved and a failed rollback-attempt journal segment is appended separately.

- Add integration tests where a later rollback retry sees both the original process journal segment and previous failed rollback-attempt segments.

- Add integration tests where rollback succeeds and deletes item state, including process and rollback-attempt journal segments.

- Add tests proving progress-only migrations persist item progress but no durable destination tracking.

- Add tests proving status does not initialize destination helpers or execute destination effects.

- Add migration reference lookup tests for record-backed and progress-only referenced definitions.

- Add rollback-preparation tests proving rollbackable state is based on persisted destination tracking evidence.

- Add rollback lifecycle tests proving successful rollback over durable destination evidence removes item state, while failed rollback preserves the original item state.

- Add file-store tests for durable encoding and decoding of process journal segments, failed rollback-attempt journal segments, diagnostic entries, tracking records, and malformed tracking data.

- Add type-level or compile-time tests around tracking record inference where the repo already uses TypeScript assertions.

- Keep legacy command-plan tests until their behavior is intentionally removed or migrated. New tests should prefer scoped process tracking.

## Out of Scope

- Provider-specific destination modules such as Commercetools or Contentful.

- A destination capability registry.

- Runtime preflight against live destination systems.

- Automatic proof that arbitrary Effect process code records all required destination changes.

- Serializable Migration Specs and Plugin Registry compilation.

- CLI item-level inspection of destination journals.

- Durable diagnostic journal storage for successful progress-only items.

- Last-write-wins semantics for multiple staged tracking records.

- Store pagination or large-catalog item-state streaming.

- A full rollback helper API for every destination capability module.

- Automatic migration of legacy command-plan item state into journal or record state.

- Removing the old command-plan implementation before the scoped tracking path is proven.

## Further Notes

- This PRD is the destination-side counterpart to the source identity contract work.

- The strongest deep module opportunities are destination change descriptors, destination journal segments, tracking record evaluation, migration contract comparison, and migration reference lookup over tracking state.

- The target semantic shift is that destination tracking uses optional, schema-valid tracking records and scoped journal evidence. A singular destination identity is no longer the durable tracking model for new migration definitions.

- Destination capability modules still own destination-native request construction, response parsing, change recording, dependency layers, and retryable error classification. Migration definitions own orchestration and optional tracking record contracts.

- `Tracking.record` should be the only public destination tracking contract for migrations expected to serve stable downstream references.

- Definitions without `Tracking.record` persist progress only on success while failed states may preserve journal evidence.

- The old command-plan authoring, plugin usage, runtime, and rollback docs are useful historical context but are explicitly marked pre-ADR-0006. New public docs and examples should point to the scoped process tracking model.
