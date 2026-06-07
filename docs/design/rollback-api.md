# Rollback API

Audience: SDK users authoring rollback-capable migrations.

Rollback is a separate SDK operation from forward migration execution. It is
driven by durable migration item state, not by source reads. A rollback pipeline
receives a rollbackable item state with a destination identity and returns a
normal destination command plan that compensates destination-side effects.

This document describes the first implementation slice. It avoids broader
public API consolidation and store pagination changes.

## Authoring Model

A migration definition may provide a `rollback` pipeline alongside the forward
`pipeline`:

```ts
const articles = defineMigration({
  id: "articles",
  source,
  destination,
  store,
  pipeline: (source) => [
    destination.commands.upsertEntry({
      title: source.item.title,
    }),
    destination.commands.publishEntry(),
  ],
  rollback: (state) => [
    destination.commands.unpublishEntry(state.destinationIdentity),
    destination.commands.deleteEntry(state.destinationIdentity),
  ],
});
```

Rollback pipelines receive the rollbackable item state and a minimal
`RollbackContext` with the definition id and rollback run id. The state carries
source identity, source version, destination identity, destination version,
status, and any existing migration error data.
The rollback input is the full narrowed item state, not an identity-only object,
so rollback authors may branch on status such as `migrated`, `needs-update`, or
`failed`.

Rollback commands are ordinary destination commands. Destination plugins expose
commands such as `createEntry`, `publishEntry`, `unpublishEntry`, and
`deleteEntry`; the rollback pipeline chooses the compensation sequence.
Rollback command factories should accept the existing destination identity type
ergonomically. If identities are branded, rollback authors should be able to
pass `state.destinationIdentity` without manual unwrapping.

Rollback does not infer inverse commands from the forward command plan.
The migration definition property is named `rollback`.
Rollback pipelines may return a command plan directly or an `Effect` that
produces a command plan. The first slice does not add source services or
`MigrationReferenceLookup` to rollback pipeline requirements.
Known rollback pipeline errors should remain typed end to end, following the
same typed-error discipline as forward migration pipelines.
Rollback pipeline failures use the same pipeline error treatment as forward
migration pipeline failures in the first slice.

## Rollbackable States

The runtime passes only rollbackable item states to the rollback pipeline. A
rollbackable state is any migration item state that records a destination
identity:

```ts
type RollbackableMigrationItemState =
  | MigratedItemState
  | NeedsUpdateItemState
  | (FailedItemState & { readonly destinationIdentity: DestinationIdentity });
```

This includes `needs-update` states created for destination stubs when they
contain a destination identity. It excludes skipped states and failed states
without a destination identity.

## Rollback Operation

Rollback is exposed as a separate SDK operation. The implemented
single-definition helper is:

```ts
yield* rollbackMigration(articles);
```

Identity-targeted rollback is a planned single-definition helper mode:

```ts
yield* rollbackMigration(articles, {
  sourceIdentities: ["article-123"],
});
```

`sourceIdentities` should accept one or more source identities for the selected
definition. An empty `sourceIdentities` array is a request validation failure.
Omit `sourceIdentities` to rollback all rollbackable states for the definition.
Duplicate source identities are deduplicated while preserving first occurrence
order.

The first slice is SDK-first. There is no CLI yet, but the request shape should
support future CLI options such as selected definitions, source identities, and
forced dependency bypass.

`rollbackMigration(definition)` rolls back all rollbackable states for that
definition. Advanced multi-definition selection is planned as
`rollbackMigrations(request)`. It should use the same definition selection
semantics as `runMigrations`: omitting `definitionIds` selects all provided
definitions. A future CLI can make per-definition rollback selection a visible
command surface. Source identity selection should stay off
`rollbackMigrations`; source identities are per-definition and become ambiguous
across multiple definitions. If multi-definition identity targeting is needed
later, it should use an explicit per-definition target shape.

## Execution Semantics

Rollback uses the same destination plugin, destination command definitions,
destination command executor, migration definition locks, and destination retry
strategy as forward migration execution.
The destination retry strategy applies only to destination command execution.

Rollback command execution reuses `DestinationCommandContext`. The context uses
the rollback run id, the rollbackable state's source identity and source
version, and sets `previousState` to the rollbackable item state. The rollback
pipeline remains the primary place to decide which commands to emit.

The first slice locks the selected rollback definitions. Dependency preflight
may inspect unselected dependent definitions for rollbackable item state, but it
does not lock those unselected dependents.

Successful rollback requires the entire rollback command plan to succeed. On
success, the runtime deletes the migration item state through a dedicated
`MigrationStore` item-state deletion operation. On failure, the original item
state is preserved so a later rollback attempt retains destination identity and
version evidence.
The runtime deletes item state immediately after each successful item rollback
so rollback progress is durable across process crashes.
Rollback command handlers should prefer idempotent behavior where possible,
especially for destructive commands such as unpublish or delete. The runtime
does not enforce idempotency.

Item-level rollback failures do not stop the rollback definition immediately.
The runtime continues attempting remaining selected item states, then marks the
rollback definition summary and top-level rollback summary failed when any item
rollback failed.

Rollback pipeline failures and destination command execution failures are both
item-level rollback failures. Both preserve the original item state and
increment the rollback `failed` count.
Rollback failures do not overwrite item state with rollback error details in the
first slice. The original item state remains unchanged.

Rollback pipelines do not support `Skip Item` or a rollback-specific skip
outcome in the first slice. The `skipped` count is reserved for selected states
or identities that are not rollbackable.

Rollback command plans must contain at least one destination command. Empty
rollback command plans are item-level rollback failures.

Rollback command plans may contain only side-effect-only destination commands.
Identity-bearing command kinds are rejected during rollback command plan
validation. Rollback compensates an existing durable destination identity; it
must not create or replace a destination identity.

Destination identities or versions returned by rollback command execution are
ignored for durable item state purposes.

Rollback does not read source items and does not update the source cursor.
The first slice accepts normal migration definitions and does not introduce a
separate rollback-only definition shape. Source configuration may still be
present on the definition, but rollback execution must not call source reads.

## Dependency Semantics

Rollback never silently expands to dependent migration definitions. If a
selected definition has unselected dependents with rollbackable item state, the
rollback run fails preflight.
Unselected dependents with no rollbackable item state do not block rollback.
Dependent preflight uses the transitive dependent closure, not only direct
dependents.
Identity-targeted rollback uses the same definition-level dependency preflight
in the first slice. It does not attempt per-item dependent reference analysis.
Rollback dependency preflight operates over the definitions supplied to the
request and follows the same same-store boundary as forward multi-definition
runs.
If dependency safety requires inspecting a dependent definition, that definition
must be present in the request graph. The first SDK slice does not discover
missing definitions; a future CLI may expand the supplied graph through
definition discovery.
Missing dependent definitions fail preflight only when they affect rollback
safety for the selected definitions.

Definitions may remain forward-only. A selected definition without a rollback
pipeline fails preflight only when rollbackable item state is selected for that
definition.

Preflight failures happen before durable run creation. Request validation and
dependency safety failures do not create a durable run state in the first
rollback slice.
Dependency cycles are preflight failures, as they are for forward migration
runs.
Rollback uses distinct rollback runtime errors for public request and preflight
failures, such as missing rollback pipelines, unsafe dependents, missing
dependent definitions, and empty identity selections. Store and destination
errors keep their existing lower-level error types.

When multiple selected definitions are valid for rollback, the runtime executes
them in reverse dependency order:

```text
forward:  authors -> articles
rollback: articles -> authors
```

Rollback does not guarantee item order within one migration definition. Future
execution adapters may parallelize rollback item execution.

A future force option may intentionally bypass dependency preflight. That option
is not part of the first slice.

## Summary Shape

Rollback returns a separate rollback run summary instead of overloading the
forward migration summary:

```ts
interface RollbackRunSummary {
  readonly kind: "rollback";
  readonly runId: MigrationRunId;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: "succeeded" | "failed";
  readonly definitions: readonly RollbackDefinitionRunSummary[];
}

interface RollbackDefinitionRunSummary {
  readonly definitionId: MigrationDefinitionId;
  readonly status: "succeeded" | "failed";
  readonly counts: {
    readonly rolledBack: number;
    readonly failed: number;
    readonly skipped: number;
  };
}
```

Rollback summary counts are returned to the current SDK caller. They are not
durable run state in the first version.
Rollback summaries include aggregate counts only in the first slice, matching
the current migration summary shape. Item-level reporting can come from store
inspection or future reporting APIs.
Item-level rollback error details are not returned in the rollback summary in
the first slice.
The first slice does not add rollback-specific fields to durable
`MigrationRunState`; operation kind and counts live in the returned rollback
summary.

`skipped` counts item states or targeted source identities that are not
rollbackable, such as skipped item states, failed item states without a
destination identity, or identities with no item state. Like forward migration
summaries, rollback definition status is `failed` only when the failed count is
greater than zero; no-op rollback definitions still succeed.
Targeted source identities with no item state count as skipped, not request
validation failures.
Selected skipped item states count as skipped and remain unchanged.
For definition-wide rollback, `rolledBack + failed + skipped` equals the
selected item states inspected for that definition. For targeted rollback, it
equals the deduplicated source identities requested.

## Implemented SDK Surface

The rollback foundation includes:

- optional `rollback` pipeline support on `MigrationDefinition`
- exported `RollbackPipeline`, `RollbackContext`, and
  `RollbackableMigrationItemState` types
- schema-backed `RollbackContext`, `RollbackMigrationOptions`,
  `RollbackDefinitionRunSummary`, and `RollbackRunSummary`
- `RollbackRequest` and `RollbackMigrationOptions` input normalizers that use
  branded definition and source identity values
- distinct `RollbackRequestError` and `RollbackPreflightError` classes for
  later public request and safety failures
- `MigrationStore.deleteItemState(definitionId, sourceIdentity)`
- in-memory and file-store deletion behavior for migration item state
- public exports for the rollback foundation beside the existing run exports

The single-definition rollback operation includes:

- `rollbackMigration(definition)` for all rollbackable item states on one
  migration definition
- definition lock acquisition and normal migration run lifecycle reuse
- durable item-state selection without source reads, source identity lookups, or
  source cursor updates
- rollback pipeline execution with the full narrowed rollbackable item state and
  `RollbackContext`
- destination command execution through the existing destination plugin,
  command definitions, command context, command executor, and destination retry
  strategy
- rollback command-plan validation for non-empty plans and no identity-bearing
  commands
- immediate item-state deletion after each successful item rollback
- state preservation for rollback pipeline failures and destination command
  failures
- aggregate-only `RollbackRunSummary` counts for `rolledBack`, `failed`, and
  `skipped`

Remaining rollback execution work:

- `rollbackMigrations` executes selected definitions in reverse dependency
  order and blocks unselected dependents with rollbackable state.
- Identity-targeted `rollbackMigration` deduplicates identities, rejects an
  empty identity list, and counts missing or non-rollbackable identities as
  skipped.

The first rollback implementation should not add CLI commands, dry-run or
planning mode, store pagination, a terminal rolled-back item state, or a public
migration executable object.

Future work may group operations under a migration executable API:

```ts
const executable = makeMigrationExecutable({ definitions });

yield* executable.run(...);
yield* executable.rollback(...);
```
