# Add Registry Run and Rollback Planning

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add structured registry planning for run and rollback commands. Registry planning should resolve explicit selection, required dependency expansion, execution order, target source identities, optional dependency participation, and non-fatal notices without touching runtime systems.

This slice should also add thin registry run and rollback helpers that delegate to existing runtime operations after a valid plan exists.

## Acceptance criteria

- [x] `planRun` requires explicit scope through `all: true` or at least one definition id.
- [x] `planRollback` requires explicit scope through `all: true` or at least one definition id.
- [x] Planning rejects unknown definition ids with typed planning errors.
- [x] Planning rejects missing explicit required dependencies when `withDependencies` is false.
- [x] Planning expands only required dependencies when `withDependencies` is true.
- [x] Planning accepts `withDependencies` with all-registry selection as redundant.
- [x] Planning never expands optional dependencies into command scope.
- [x] Planning records optional dependency edges only when both sides are included in the plan.
- [x] Run planning returns execution definition ids in forward dependency order.
- [x] Rollback planning returns execution definition ids in reverse dependency order.
- [x] Requested definition ids are preserved in requested order separately from normalized execution order.
- [x] Duplicate requested definition ids are deduplicated for inclusion and execution and surfaced as plan notices.
- [x] Optional dependency cycles degrade the whole plan to required-dependency ordering, preserve deterministic registry order for optional relationships, and surface notices instead of failing.
- [x] Missing optional dependency ids remain inspection concerns and do not produce run or rollback plan notices.
- [x] Rollback target planning accepts one or more source identities for exactly one explicit definition id.
- [x] Rollback target planning rejects target ids with all-registry selection or multiple explicit definitions.
- [x] Rollback target planning rejects required dependency expansion until cross-definition target identity mapping is designed.
- [x] Forward item-mode planning accepts exactly one source identity for exactly one explicit definition id.
- [x] Forward item-mode planning rejects more than one unique source identity.
- [x] Forward item-mode planning rejects combinations with all-registry selection, multiple definitions, required dependency expansion, failed mode, and skipped mode.
- [x] Duplicate source identities are deduplicated for targeting and surfaced as plan notices.
- [x] Registry run and rollback helpers delegate to existing runtime operations after planning.
- [x] Registry rollback helpers preserve lower-level dependent rollback safety by passing the full registry graph and selected definition ids into runtime preflight.
- [x] Tests assert structured plan values directly instead of snapshotting CLI text.

## Blocked by

- [Add Static Migration Definition Registry](./01-add-static-migration-definition-registry.md)
