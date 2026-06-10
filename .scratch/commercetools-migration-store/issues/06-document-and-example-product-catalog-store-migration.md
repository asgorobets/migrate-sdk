# Document And Example A Product Catalog Store Migration

Status: ready-for-agent

## Parent

.scratch/commercetools-migration-store/PRD.md

## What to build

Add migration-author-facing documentation and an example Commercetools product
catalog migration that composes the Custom Object-backed migration store with
the Commercetools destination plugin.

The example should demonstrate the intended authoring experience: configure the
Commercetools SDK layer, configure the migration store with a container and
namespace, configure the Commercetools destination, and run a small product
catalog migration using the durable store.

## Acceptance criteria

- [ ] Documentation shows how to import and configure the Commercetools migration store.
- [ ] Documentation shows how to use the same Commercetools project for destination and state.
- [ ] Documentation shows how to use a separate Commercetools project for state.
- [ ] Documentation explains container and namespace choices.
- [ ] Documentation explains that direct item processing uses keys while list and maintenance paths use indexed predicates.
- [ ] Documentation explains the durable lock behavior and the lack of automatic lock expiry.
- [ ] The package includes an example product catalog migration that uses the migration store and Commercetools destination together.
- [ ] The example demonstrates product creation or update through the destination plugin.
- [ ] The example demonstrates durable store wiring rather than the in-memory store.
- [ ] The example can be typechecked or tested without live Commercetools credentials.
- [ ] Operational force-unlock, export, cleanup, and live integration tests remain documented as future work rather than implemented behavior.
- [ ] Typecheck and relevant example tests pass.

## Blocked by

- .scratch/commercetools-migration-store/issues/02-persist-store-records-as-custom-objects.md
- .scratch/commercetools-migration-store/issues/03-implement-version-zero-definition-locks.md
- .scratch/commercetools-migration-store/issues/04-add-indexed-query-scans-for-item-state-listing.md
