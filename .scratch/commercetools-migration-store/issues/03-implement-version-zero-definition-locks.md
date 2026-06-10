# Implement Version-Zero Definition Locks

Status: ready-for-agent

## Parent

.scratch/commercetools-migration-store/PRD.md

## What to build

Implement durable migration definition locks using one Commercetools Custom
Object per locked definition. Lock acquisition must use Custom Object
create-if-absent behavior by writing the lock record with version zero. Lock
release must read the current lock, verify ownership, and delete by current
version.

This slice should make concurrent runners safe for the Commercetools migration
store without adding automatic lock expiry or force-unlock tooling.

## Acceptance criteria

- [x] `acquireDefinitionLock` creates a lock Custom Object with version zero.
- [x] A successful lock acquisition returns the core migration definition lock shape.
- [x] A concurrent modification during lock creation maps to a clear store-level lock acquisition failure.
- [x] Other SDK errors during lock acquisition map to `MigrationStoreError`.
- [x] Lock records include definition id, owner run id, token, and created-at time.
- [x] Lock release reads and decodes the current lock record before deletion.
- [x] Lock release verifies owner run id and token before deleting.
- [x] Lock release refuses to delete a lock owned by another runner.
- [x] Lock release deletes the current lock Custom Object by version.
- [x] Missing lock behavior matches the existing core store contract.
- [x] Typecheck and relevant lock tests pass.

## Blocked by

- .scratch/commercetools-migration-store/issues/01-add-commercetools-migration-store-slice.md
