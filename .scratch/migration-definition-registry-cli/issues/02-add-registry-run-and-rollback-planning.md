# Add Registry Run and Rollback Planning

Status: ready-for-agent

## Parent

[Migration Definition Registry and CLI](../PRD.md)

## What to build

Add structured registry planning for run and rollback commands. Registry planning should resolve explicit selection, required dependency expansion, execution order, target source identities, optional dependency participation, and non-fatal notices without touching runtime systems.

This slice should also add thin registry run and rollback helpers that delegate to existing runtime operations after a valid plan exists.

## Acceptance criteria

- [ ] `planRun` requires explicit scope through `all: true` or at least one definition id.
- [ ] `planRollback` requires explicit scope through `all: true` or at least one definition id.
- [ ] Planning rejects unknown definition ids with typed planning errors.
- [ ] Planning rejects missing explicit required dependencies when `withDependencies` is false.
- [ ] Planning expands only required dependencies when `withDependencies` is true.
- [ ] Planning accepts `withDependencies` with all-registry selection as redundant.
- [ ] Planning never expands optional dependencies into command scope.
- [ ] Planning records optional dependency edges only when both sides are included in the plan.
- [ ] Run planning returns execution definition ids in forward dependency order.
- [ ] Rollback planning returns execution definition ids in reverse dependency order.
- [ ] Requested definition ids are preserved in requested order separately from normalized execution order.
- [ ] Duplicate requested definition ids are deduplicated for inclusion and execution and surfaced as plan notices.
- [ ] Optional dependency cycles preserve deterministic registry order and surface notices instead of failing.
- [ ] Missing optional dependency ids remain inspection concerns and do not produce run or rollback plan notices.
- [ ] Rollback target planning accepts one or more source identities for exactly one explicit definition id.
- [ ] Rollback target planning rejects target ids with all-registry selection or multiple explicit definitions.
- [ ] Forward item-mode planning accepts exactly one source identity for exactly one explicit definition id.
- [ ] Forward item-mode planning rejects more than one unique source identity.
- [ ] Forward item-mode planning rejects combinations with all-registry selection, multiple definitions, required dependency expansion, failed mode, and skipped mode.
- [ ] Duplicate source identities are deduplicated for targeting and surfaced as plan notices.
- [ ] Registry run and rollback helpers delegate to existing runtime operations after planning.
- [ ] Tests assert structured plan values directly instead of snapshotting CLI text.

## Blocked by

- [Add Static Migration Definition Registry](./01-add-static-migration-definition-registry.md)
