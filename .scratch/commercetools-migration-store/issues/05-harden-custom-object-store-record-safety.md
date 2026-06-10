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

- [x] Unknown future record format versions fail decoding clearly.
- [x] Persisted record schemas do not rely on explicit null values for required semantics.
- [x] Long definition ids produce valid bounded key segments.
- [x] Unsafe definition ids produce valid bounded key segments.
- [x] Long source identities produce valid bounded key segments.
- [x] Unsafe source identities produce valid bounded key segments.
- [x] Generated key segments include semantic prefixes for hashed definition and identity values.
- [x] Direct lookup validates decoded definition id metadata against the requested definition.
- [x] Direct item lookup validates decoded source identity metadata against the requested source identity.
- [x] Collision or corrupt-record mismatches fail as store errors instead of returning the wrong state.
- [x] Internal key, record, and query helpers remain unexported from the public package surface.
- [x] Typecheck and relevant hardening tests pass.

## Blocked by

- .scratch/commercetools-migration-store/issues/02-persist-store-records-as-custom-objects.md
- .scratch/commercetools-migration-store/issues/03-implement-version-zero-definition-locks.md
- .scratch/commercetools-migration-store/issues/04-add-indexed-query-scans-for-item-state-listing.md
