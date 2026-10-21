# State records and lifecycle semantics

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Implement JSON record persistence for every non-lock MigrationStore method.
Reuse core schemas, transition helpers, completion and superseded-run scenarios.
Keep provider persistence private and use bounded concurrency. This slice is
not independently releasable until advisory locking is implemented.

## Acceptance criteria

- [x] Deterministic safe keys and envelopes validate kind/version/binding/original identities; malformed or future data fails closed.
- [x] Every item state, journal, Tracking Record, contract, cursor, and completion round-trips across a fresh store instance.
- [x] Canonical history and latest projections preserve newer runs and per-definition outcomes during replay and repair.
- [x] Shared local serialization prevents acknowledged cancellation from being overwritten and keeps terminal states absorbing.
- [x] Rollback invalidates completion/cursor before removal; missing item is a no-op and ambiguous deletion never restores completion.
- [x] Observation never inserts missing items; orphan results obey encoded identity order and exclusive cursor despite unordered hash keys/deletion.
- [x] Summary and listing use canonical records; bounded candidate scans and request costs are documented.
- [x] Failure injection covers every compound write boundary and verifies conservative restart behavior.
- [x] Tested state-client assumptions cover read/list visibility, whole-record publication, and plugin restrictions.

## Blocked by

[01: package and Effect boundary](01-package-and-effect-boundary.md).

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.
