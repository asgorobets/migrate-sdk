# Add Indexed Query Scans For Item State Listing

Status: ready-for-agent

## Parent

.scratch/commercetools-migration-store/PRD.md

## What to build

Implement set-oriented reads for the Commercetools migration store using Custom
Object query predicates over denormalized scalar index metadata. The first
public behavior to wire through is `listItemStates(definitionId)`.

Unbounded scans must use keyset pagination sorted by Custom Object key. The
store should avoid offset pagination and avoid total-count computation for
internal scans.

## Acceptance criteria

- [ ] Item-state records include scalar index metadata needed to query by namespace and definition id.
- [ ] `listItemStates(definitionId)` filters records by namespace, record kind, and definition id.
- [ ] Query predicates are built through a centralized internal query builder.
- [ ] User-provided predicate values are escaped or bound through one internal path.
- [ ] Query scans sort by Custom Object key.
- [ ] Query scans use the last key from the previous page as the next page cursor.
- [ ] Query scans request no more than the configured page size.
- [ ] Query scans disable total-count computation.
- [ ] Multi-page scans collect all matching item states for the current public `MigrationStore` API.
- [ ] Tests prove scanning continues beyond one page without using offset.
- [ ] Typecheck and relevant query/listing tests pass.

## Blocked by

- .scratch/commercetools-migration-store/issues/02-persist-store-records-as-custom-objects.md
