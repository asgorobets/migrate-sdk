# Migration Contract Drift Guard

Status: ready-for-human

## Parent

[Source Identity Contracts](../PRD.md)

## What to build

Persist and enforce source-side Migration Contract fingerprints.

This slice should record the source identity contract used by a migration
definition and the source version contract used for each observed item state.
The runtime blocks execution when existing item state was written under
incompatible source identity semantics. Source version contract changes do not
block the whole migration; they make existing source versions non-comparable
until a read item is processed and rewritten with the current source version
contract fingerprint.

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
- [ ] Source version contract semantics are recorded separately from source
      identity semantics.
- [ ] The Migration Store persists the source identity contract fingerprint for
      each migration definition.
- [ ] Migration Item State persists the source version contract fingerprint that
      was used to observe its `sourceVersion`.
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
- [ ] A migration definition with existing item state is not blocked when only
      source version contract semantics change.
- [ ] A migrated item is counted as unchanged only when both its `sourceVersion`
      and source version contract fingerprint match the current source item and
      definition.
- [ ] A source version contract mismatch causes a read source item to be
      processed and rewritten with the current source version contract
      fingerprint when the item succeeds, skips, or fails after source decoding.
- [ ] Contract mismatch blocking applies when any Migration Item State exists,
      including failed, skipped, migrated, and in-progress state.
- [ ] Contract mismatch blocking happens before source reads begin.
- [ ] Source version contract mismatch is resolved item-by-item during normal
      source reads, not by first-row scans or sampled source items.
- [ ] Existing cursor semantics are not changed by this slice; a future cursor
      reset or full-rescan mode can force all stored items through source
      version contract rekeying.
- [ ] Contract mismatch errors identify the current and stored contract details
      well enough for status output or future reset/rekey tooling.
- [ ] First-row scans or sampled source items are not used as the primary drift
      detector.
- [ ] Tests cover both allowed brand-new execution and blocked execution with
      existing item state.

## Blocked by

[End-To-End Source Identity Contract Migration](01-end-to-end-source-identity-contract-migration.md)
