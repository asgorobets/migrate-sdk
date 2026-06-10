# Add Commercetools Migration Store Package Slice

Status: ready-for-agent

## Parent

.scratch/commercetools-migration-store/PRD.md

## What to build

Add the public Commercetools migration-store package slice and a working
SDK-backed store shell. Migration authors should be able to import a
`CommercetoolsMigrationStore`, configure container, namespace, and page size,
and provide the existing Commercetools SDK layer as the store dependency.

This slice should establish the public API, option defaults, option validation,
package export, and fake-SDK test harness. It does not need to implement every
store operation yet, but the entrypoint must be real enough for later slices to
fill in behavior through the existing `MigrationStore` service boundary.

## Acceptance criteria

- [ ] The Commercetools package exposes a public migration-store subpath.
- [ ] Migration authors can construct a store layer from options and an existing Commercetools SDK layer.
- [ ] Migration authors can construct a convenience store layer from API root, project key, and store options.
- [ ] Store options include container, namespace, and page size with documented defaults.
- [ ] Invalid container, namespace, or page-size options fail clearly before the store is used.
- [ ] Internal helpers for the store are not exported from the public package surface.
- [ ] Tests use a fake Commercetools SDK layer rather than live credentials.
- [ ] Typecheck passes for the Commercetools package.

## Blocked by

None - can start immediately
