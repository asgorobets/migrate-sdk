# Align Source And Store With Current Runtime Contracts

Status: done

Type: AFK

## Parent

[Commercetools Process Destination Capabilities](../PRD.md)

## User stories covered

18, 32, 33, 34, 35, 36, 37, 38, 43, 44, 45

## What to build

Bring the Commercetools source plugins and Custom Object Migration Store back
onto the current core runtime contracts before changing destination helpers.
This slice should make the source and store boundaries compile and behave
against the current Process Pipeline, Source Identity, Tracking Record,
Destination Journal, and Migration Item State model.

Commercetools sources must use schema-backed source identity definitions,
current `ConfiguredSourcePlugin` generic ordering, current `SourceItemInput`
fields, and `identityKey` emission. `read` and `readByIdentity` should continue
to preserve existing Commercetools resource projections and lookup behavior.

The Custom Object Migration Store must persist the current
`MigrationItemState` shape, including structured source identity snapshots,
optional Tracking Records, Destination Journal process segments, rollback
attempt segments, and malformed-state rejection. Existing Custom Object key
strategy, locking, run-state, source-cursor, keyset pagination, and namespace
decisions may remain unless they conflict with current core contracts.

## Acceptance criteria

- [x] Commercetools source plugin types align with the current core source plugin contracts.
- [x] Source identity definitions include stable ids, schemas, and key derivation.
- [x] Source item inputs emit `identityKey` and no longer depend on legacy `identity` fields.
- [x] `readByIdentity` targets the current structured source identity contract.
- [x] Existing business-unit, customer, and product source projection options still work through public source tests.
- [x] Custom Object item state records round-trip current migrated, skipped, failed, and needs-update state variants.
- [x] Custom Object state records persist structured source identity snapshots.
- [x] Custom Object state records persist optional Tracking Records when present.
- [x] Custom Object state records persist Destination Journal process segments when present.
- [x] Custom Object state records persist rollback-attempt segments when present.
- [x] Store schemas reject malformed Tracking Record and Destination Journal payloads.
- [x] Store code no longer depends on singular destination identity or destination version fields.
- [x] Existing Custom Object locking, run-state, cursor, pagination, key-generation, and collision tests still pass or are updated to current contracts.
- [x] Focused Commercetools source and migration-store tests pass without live credentials.
- [x] `pnpm --filter @migrate-sdk/commercetools check-types` no longer fails for source or migration-store contract drift.

## Blocked by

None - can start immediately.

## Comments

- Implemented with focused TDD on `packages/commercetools/src/source/plugin.test.ts` and `packages/commercetools/src/migration-store/migration-store.test.ts`.
- `pnpm --filter @migrate-sdk/commercetools check-types` still fails on legacy destination command APIs and examples scheduled for follow-up issues, but the reported failures no longer include `src/source` or `src/migration-store` contract drift.
