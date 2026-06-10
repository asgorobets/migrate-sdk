# Persist Migration Store Records As Custom Objects

Status: ready-for-agent

## Parent

.scratch/commercetools-migration-store/PRD.md

## What to build

Implement the core durable record path for the Commercetools migration store.
Source cursors, migration item state, and latest run state should round-trip
through Commercetools Custom Objects using deterministic generated keys and
schema-backed record envelopes.

Direct reads must use Custom Object key lookup, not query predicates. Writes
should upsert the relevant Custom Object record. Item-state deletion should read
the current record and delete it by version.

## Acceptance criteria

- [ ] Source cursors round-trip through the public `MigrationStore` service boundary.
- [ ] Migrated item state round-trips through the public `MigrationStore` service boundary.
- [ ] Skipped item state round-trips through the public `MigrationStore` service boundary.
- [ ] Failed item state round-trips through the public `MigrationStore` service boundary.
- [ ] Needs-update item state round-trips through the public `MigrationStore` service boundary.
- [ ] Latest running, succeeded, and failed run state records round-trip through the public `MigrationStore` service boundary.
- [ ] Direct source cursor lookup uses a deterministic generated Custom Object key.
- [ ] Direct item-state lookup uses a deterministic generated Custom Object key.
- [ ] Item-state deletion deletes the current Custom Object by version.
- [ ] Missing cursor and item-state Custom Objects map to the core store's expected null result.
- [ ] Record envelopes include format version, namespace, record kind, state, and any needed query index metadata.
- [ ] Generated keys use the `__` delimiter and bounded safe segments for dynamic values.
- [ ] Typecheck and relevant store tests pass.

## Blocked by

- .scratch/commercetools-migration-store/issues/01-add-commercetools-migration-store-slice.md
