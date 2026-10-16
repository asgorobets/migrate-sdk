# Advisory locks and supported writer topology

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Complete FilesSDKMigrationStore with durable advisory locks, explicit configuration,
ownership assertions, normal unlock integration, and the PRD's disclosure.
Record the scoped exception to atomic conflict exclusion in an ADR and glossary
documentation. Do not add lease expiry or a distributed lock service.

## Acceptance criteria

- [x] `locking: "advisory"` is explicit and the disclosure logs once per shared store construction.
- [x] Acquire reads, writes a unique owner/token, and verifies; existing locks block acquisition and never expire automatically.
- [x] Get/assert/release/break match the full core service; owner/token mismatches fail without intentional foreign-owner deletion.
- [x] Same-process contending fibers and release races are serialized.
- [x] A scripted two-process interleaving demonstrates both contenders can pass readback; tests do not imply mutual exclusion.
- [x] Check-then-delete race, force-unlock behavior, single authoritative writer (including cancellation), and unsupported distributed workflow control are documented.
- [x] Existing server unlock/status and same-server stop/completion integration tests pass with this store.
- [x] Native conditional mode remains deferred; no conditional capability is silently simulated or used as a claim of transactional state.

## Blocked by

[04: state records and lifecycle](04-state-records-and-lifecycle.md).

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.
