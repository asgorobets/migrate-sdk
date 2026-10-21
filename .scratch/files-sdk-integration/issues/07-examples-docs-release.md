# Examples, documentation, and provider qualification

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Ship first-party documentation, scripted testing helpers, and executable
examples that demonstrate all three independent roles. Qualify the initial
state backends and publish only the guarantees actually tested.

## Acceptance criteria

- [x] Credential-free memory/filesystem examples cover transfer, restart, unchanged skip, update, retry, explicit rollback, and remote JSON selection.
- [x] Three independent client bindings and disjoint prefixes are visible in the example; no credentials or real state is committed.
- [x] Persistent-server tests cover detach/reobserve and cooperative stop using one shared store writer.
- [x] Gated disposable-prefix S3 and R2 suites are included for pagination, object publication/read visibility, lifecycle, and cleanup; live execution requires external credentials and was not performed.
- [x] Source, destination, store, support matrix, lock disclosure, request costs, retry/verification, and rollback limitations are documented.
- [x] Existing SQL-store example demonstrates Files source/destination without accepting advisory state semantics.
- [x] New package types/tests/build and affected core/docs checks pass; emitted package subpaths work in a packed consumer.
- [x] Release notes name the advisory store's operating limits and avoid claiming all Files adapters are certified state backends.

## Blocked by

[02](02-object-source.md), [03](03-destination-and-transfer.md),
[04](04-state-records-and-lifecycle.md), [05](05-advisory-locking.md), and
[06](06-document-fetcher.md).

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.
