# Harden Custom Object Store Record Safety

Status: ready-for-agent

## Parent

.scratch/commercetools-migration-store/PRD.md

## What to build

Harden the Commercetools migration store record format and generated keys
against corruption, future format drift, and platform-specific JSON behavior.
This slice should make the persistence format safe enough to become the stable
foundation for future inspection, cleanup, export, and force-unlock tooling.

## Acceptance criteria

- [ ] Unknown future record format versions fail decoding clearly.
- [ ] Persisted record schemas do not rely on explicit null values for required semantics.
- [ ] Long definition ids produce valid bounded key segments.
- [ ] Unsafe definition ids produce valid bounded key segments.
- [ ] Long source identities produce valid bounded key segments.
- [ ] Unsafe source identities produce valid bounded key segments.
- [ ] Generated key segments include semantic prefixes for hashed definition and identity values.
- [ ] Direct lookup validates decoded definition id metadata against the requested definition.
- [ ] Direct item lookup validates decoded source identity metadata against the requested source identity.
- [ ] Collision or corrupt-record mismatches fail as store errors instead of returning the wrong state.
- [ ] Internal key, record, and query helpers remain unexported from the public package surface.
- [ ] Typecheck and relevant hardening tests pass.

## Blocked by

- .scratch/commercetools-migration-store/issues/02-persist-store-records-as-custom-objects.md
- .scratch/commercetools-migration-store/issues/03-implement-version-zero-definition-locks.md
- .scratch/commercetools-migration-store/issues/04-add-indexed-query-scans-for-item-state-listing.md
