# Migration Executable Workflows

Status: ready-for-agent

## Problem Statement

Migration execution needs to be registry-first. Inline execution, tests, CLIs,
and durable workflow hosts should all start from registry planning and delegate
the resulting executable plan to a swappable service.

The SDK now has a **Migration Definition Registry** that can select and plan
multi-definition runs and rollbacks. The next step is to make execution
registry-first as well: registry planning should produce executable plans, and a
provided **Migration Executable** service should start those plans inline or
through a durable workflow provider.

The public API must not be designed around Workflow SDK queues, worker names, or
Effect workflow internals. It should expose migration language: executable
registries, executable plans, migration run ids, migration execution envelopes,
adapter execution handles, locks, and run state. Workflow SDK and Effect
workflow support should be adapter patterns over that API.

## Solution

Add an executable execution boundary to the SDK.

The **Executable Migration Definition Registry** is a registry view that plans
only executable runs and rollback runs. It validates that selected definitions
have their runtime requirements provided before the execution plan can be passed
to **Migration Executable**.

The **Migration Executable** is an Effect service provided by layer. It accepts
only executable run and rollback plans. The default layer is
`MigrationExecutable.inline`, which delegates to the existing runtime and returns
completed summaries. Durable adapters use the same service contract but return a
started **Execution Start Result** after a provider-owned workflow execution is
accepted.

Distributed adapters derive a serializable **Migration Execution Envelope** from
the executable plan. The envelope carries the migration run id, registry id,
kind, selected definitions, request, and diagnostic planned order. The provider
workflow rehydrates a registry from the **Migration Definition Registry Catalog**
and re-plans inside the workflow execution context before executing. The
envelope is not a frozen executable plan.

Workflow SDK and Effect workflow are useful design checks for the adapter shape,
but actual provider adapters are not part of this PRD. Those adapters require a
separate implementation discussion around package boundaries, peer dependencies,
runtime worlds, deployment assumptions, Effect Cluster wiring, and production
durability.

Existing function-style entrypoints remain compatibility wrappers over the
executable registry and inline executable.

## User Stories

1. As an SDK user, I want registry-backed executable plans, so that execution
   starts from the same selection and ordering model as CLI planning.

2. As an SDK user, I want `MigrationExecutable.startRun(plan)`, so that run
   execution can be swapped without changing registry planning code.

3. As an SDK user, I want `MigrationExecutable.startRollback(plan)`, so that
   rollback execution can use the same swappable service boundary.

4. As a migration author, I want missing runtime requirements to surface before
   executable planning succeeds, so that partially provided definitions cannot
   reach a workflow adapter.

5. As a migration author, I want Effect-visible requirements to remain enforced
   by types, so that statically authored definitions fail early when a layer is
   missing.

6. As an SDK maintainer, I want dynamic executable failures to include
   `missingRequirements`, so that generated registries can produce useful
   diagnostics without weakening static Effect guarantees.

7. As an operator, I want every start call to allocate a new `Migration Run` id,
   so that reruns are visible instead of hidden behind implicit idempotency.

8. As an operator, I want a durable adapter to create initial `Migration Run
   State` before returning `started`, so that the run can be observed
   immediately by migration run id.

9. As an operator, I want adapter start failures to mark run state as
   `start-failed`, so that failed scheduling attempts are diagnosable.

10. As an operator, I want attach failures to fail the start call, so that a
    returned `started` result always has enough metadata for later observation.

11. As an adapter author, I want a serializable migration execution envelope, so
    that executable plans do not need to cross workflow runtime boundaries.

12. As an adapter author, I want a registry catalog service, so that workflow
    execution can resolve code-defined registries by registry id.

13. As an adapter author, I want duplicate registry ids rejected at layer
    construction, so that workflow execution never resolves an ambiguous
    registry.

14. As an adapter author, I want `plannedOrder` to be diagnostic only, so that a
    workflow runtime's own versioning model owns code compatibility for started
    runs.

15. As an adapter author, I want workflow handlers to execute with the existing
    envelope run id, so that provider workflows do not allocate a second
    migration run.

16. As an operator, I want the durable workflow execution to own selected
    migration definition locks, so that no overlapping workflow can start while
    the run is active.

17. As an operator, I want steps inside one workflow to be allowed to parallelize,
    so that item work can be concurrent without weakening whole-run lock
    ownership.

18. As an SDK user, I want inline execution to return completed summaries, so
    that existing direct SDK usage keeps the current simple result shape.

19. As an SDK user, I want durable execution to return `started`, so that
    starting work is separate from waiting for completion.

20. As an SDK user, I want `MigrationExecution` left as a separate future
    service, so that start, observe, cancel, and resume do not get mixed into one
    public primitive.

21. As an SDK user, I want raw definition run/rollback helpers removed before
    1.0, so that the public API converges on registry-bound execution.

## Implementation Decisions

- Add executable registry planning as a view over **Migration Definition
  Registry**, not as a separate catalog concept.

- Require executable registries to have a stable registry id.

- Add distinct executable run and rollback plan types. `MigrationExecutable`
  should not accept ordinary registry plans.

- Keep executable plans in process. They may contain definitions, layers, and
  effects, and are not durable payloads.

- Add **Migration Executable** as an Effect service with `startRun` and
  `startRollback` operations.

- Provide `MigrationExecutable.inline` as the default inline execution layer.

- Keep static missing-service enforcement in Effect types where possible.

- Add a runtime executable planning error for dynamic registries. The diagnostic
  field is `missingRequirements`.

- Add **Migration Execution Envelope** as the serializable durable payload for
  distributed adapters.

- Keep `plannedOrder` in the envelope for diagnostics only.

- Add **Migration Definition Registry Catalog** as an Effect service that
  resolves registries by registry id and rejects duplicate ids when the layer is
  constructed.

- Durable adapters allocate the migration run id at start time and place it in
  the envelope.

- Durable adapters create queued migration run state before calling the provider
  start API.

- Durable adapters attach provider execution identity before returning
  `started`.

- Durable adapters mark the run state as `start-failed` when the provider does
  not accept the workflow execution after queued state was created.

- Durable adapters fail with an attach error when provider execution was
  accepted but the provider identity cannot be attached to migration run state.

- Workflow execution contexts re-plan from the registry catalog before executing
  the envelope.

- Workflow execution contexts use the envelope migration run id and must not call
  the public `MigrationExecutable.startRun` or `startRollback` again after the
  durable adapter has already allocated the run id.

- A provider-owned workflow execution owns the selected migration definition
  locks for the duration of the run.

- The started execution handle is a discriminated union. Workflow SDK handles
  store a Workflow SDK run id. Effect workflow handles store an Effect workflow
  execution id.

- Keep `MigrationExecution` as a future service for waiting, reading run state,
  streaming events, cancelling, interrupting, or resuming.

- Keep function-style run and rollback entrypoints as compatibility wrappers over
  executable registry planning and inline execution.

- Update public exports and docs together so the new public surface is
  discoverable.

## Testing Decisions

- Test executable registry planning as a domain module. Assert that executable
  planning returns branded executable plans and ordinary plans cannot be passed
  to the executable service at the type boundary.

- Test runtime executable diagnostics for dynamic registries. Assert that missing
  runtime metadata fails with `missingRequirements`.

- Test `MigrationExecutable.inline` through current run and rollback behavior.
  Assertions should focus on returned summaries, run state, item state, and lock
  behavior rather than implementation details.

- Test inline registries through `MigrationExecution.make({ registry })` to
  prove registry-bound run and rollback return completed summaries on the inline
  executable path.

- Test envelope construction as a pure domain operation. Assert it contains the
  migration run id, registry id, request, definition ids, and diagnostic planned
  order without embedding executable definitions.

- Test `MigrationDefinitionRegistryCatalog` with one registry, missing registry
  lookup, and duplicate registry id rejection.

- Test durable adapter behavior with a test provider adapter. The test harness should
  verify queued state creation, start failure marking, attach failure behavior,
  and returned started handles without depending on Workflow SDK or Effect
  workflow.

- Test lock ownership through existing in-memory and file-backed migration store
  behavior. The important external behavior is that overlapping selected
  definition sets are rejected and locks are released on terminal completion.

- Use existing registry planning tests, run/rollback runtime tests, execution
  option tests, and migration store lock tests as prior art.

## Out of Scope

Implementing a full `MigrationExecution` observation/control service.

Provider-native dashboards or status UIs.

Atomic idempotent start semantics across repeated caller requests.

Serializing executable plans or migration definitions.

Fail-closed planned-order drift protection for code-defined registries.

Changing source cursor, item-state, tracking, rollback journal, or migration
contract behavior.

Changing CLI command semantics beyond using the executable service internally
where needed.

Shipping a production Effect cluster workflow runtime.

Depending on Workflow SDK or Effect workflow in the core package if optional
adapter packaging is not settled.

Implementing a Vercel Workflow SDK `MigrationExecutable` adapter.

Implementing an Effect Workflow or Effect Cluster `MigrationExecutable` adapter.

Publishing docs-only provider adapter issues before the real implementation
discussion is ready.

## Further Notes

This PRD intentionally separates the migration public API from provider runtime
APIs. Workflow SDK and Effect workflow are validation targets for the adapter
shape, not the source of the core SDK vocabulary.

The design docs may keep short notes about how Workflow SDK and Effect workflow
fit the envelope model, but real provider adapters should get their own PRD or
issue set after package boundaries, runtime assumptions, and production wiring
are decided.

The first implementation should make the inline path real and testable before
adding provider-specific packages. A test durable provider is enough to prove
the migration run state and adapter handle semantics.
