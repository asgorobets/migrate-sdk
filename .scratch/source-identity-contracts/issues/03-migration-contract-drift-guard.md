# Migration Contract Drift Guard

Status: ready-for-agent

## Parent

[Source Identity Contracts](../PRD.md)

## What to build

Persist and enforce source-side Migration Contract fingerprints.

This slice should record the source identity contract and source version
contract used by a migration definition, compare the current definition against
stored contract state, and block execution when existing item state was written
under incompatible source identity or source version semantics.

## Acceptance criteria

- [ ] The runtime computes a source identity contract fingerprint from the
      contract id, supported source identity schema shape, tuple part names, and
      tuple part positions.
- [ ] Declarative source-to-key mapping metadata participates in the source
      identity contract fingerprint where a source plugin exposes such metadata.
- [ ] Function-based identity derivation is not fingerprinted by JavaScript
      function body text.
- [ ] Function-based identity derivation relies on the user-authored contract id
      as the compatibility promise for mapping semantics.
- [ ] Source version contract semantics participate in the stored Migration
      Contract separately from source identity.
- [ ] The Migration Store persists the source identity contract fingerprint and
      source version contract fingerprint for each migration definition.
- [ ] A brand-new migration definition with no item state can store its current
      Migration Contract and proceed.
- [ ] A migration definition with existing item state is blocked when the source
      identity schema changes.
- [ ] A migration definition with existing item state is blocked when tuple part
      order changes.
- [ ] A migration definition with existing item state is blocked when tuple part
      names that participate in the contract change.
- [ ] A migration definition with existing item state is blocked when
      declarative source-to-key mapping changes.
- [ ] A migration definition with existing item state is blocked when source
      version contract semantics change.
- [ ] Contract mismatch blocking applies when any Migration Item State exists,
      including failed, skipped, migrated, and in-progress state.
- [ ] Contract mismatch blocking happens before source reads begin.
- [ ] Contract mismatch errors identify the current and stored contract details
      well enough for status output or future reset/rekey tooling.
- [ ] First-row scans or sampled source items are not used as the primary drift
      detector.
- [ ] Tests cover both allowed brand-new execution and blocked execution with
      existing item state.

## Blocked by

[End-To-End Source Identity Contract Migration](01-end-to-end-source-identity-contract-migration.md)
