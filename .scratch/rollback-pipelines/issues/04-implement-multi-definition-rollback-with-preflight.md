# Implement Multi-Definition Rollback With Preflight

Status: done

## Parent

[Explicit Rollback Pipelines](../PRD.md)

## What to build

Implement registry-bound rollback for selected sets of migration definitions. Multi-definition rollback should use the same registry definition selection semantics as forward runs, acquire locks for selected rollback definitions, enforce dependency safety through preflight, execute selected definitions in reverse dependency order, and avoid silently expanding destructive scope to dependents.

Keep the public rollback usage documentation aligned with the implemented multi-definition and dependency behavior.

## Acceptance criteria

- [x] `MigrationExecution.make({ registry }).rollback(...)` accepts multiple definitions and optional definition selection.
- [x] Omitting `definitionIds` selects all registry definitions, matching forward runs.
- [x] Selected rollback definitions are locked before rollback commands execute and released afterward.
- [x] Unselected dependent definitions are not locked in the first slice.
- [x] Dependency cycles fail preflight before durable run creation.
- [x] Preflight failures for request validation and dependency safety happen before durable run creation.
- [x] Selected definitions execute in reverse dependency order.
- [x] Rollback does not guarantee item order within one migration definition.
- [x] Rollback never silently expands to dependent definitions.
- [x] Transitive unselected dependents with rollbackable item state fail preflight.
- [x] Unselected dependents without rollbackable item state do not block rollback.
- [x] Identity-targeted rollback uses the same definition-level dependency preflight when applicable and does not attempt per-item dependent reference analysis.
- [x] Dependent definitions can only be checked when present in the supplied request graph.
- [x] Missing selected dependencies fail preflight; omitted dependents are outside SDK visibility until registry or discovery exists.
- [x] Multi-definition rollback follows the same same-store boundary as forward multi-definition runs.
- [x] Forward-only selected definitions with no rollbackable states succeed as no-ops.
- [x] Forward-only selected definitions with rollbackable states fail preflight.
- [x] The rollback API design doc reflects the implemented multi-definition selection, locking, reverse-order execution, and dependency preflight behavior.

## Blocked by

- [Implement Single-Definition Rollback](./02-implement-single-definition-rollback.md)
