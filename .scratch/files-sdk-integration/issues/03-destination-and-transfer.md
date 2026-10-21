# Journaled destination helpers and streaming transfer

Status: ready-for-human

## Parent

[First-party Files SDK integration](../PRD.md)

## What to build

Implement locally provided upload, transferFrom, same-client copy, and explicit
delete helpers. Use upstream single-key Effect operations and normal Tracking
descriptors. Make write policy explicit and cross-client transfer replayable.

## Acceptance criteria

- [x] Explicit overwrite and native conditional policies are tested; unsupported predicates fail without a weaker fallback.
- [x] Conditional bodies remain bounded/replayable; streaming transfer requires explicit overwrite without unbounded buffering.
- [x] Transfer opens a new source download/body per attempt, bounds buffering, propagates interruption, and cancels failed streams.
- [x] Source/destination service bindings remain distinct; same-client copy is not used as cross-provider copy.
- [x] Successful changes carry durable storage/key/validator facts and can be decoded in rollback.
- [x] Consumed streams, source changes, checksum failures, post-commit/applied errors, and state/journal failures have reconciliation tests.
- [x] Retry settings do not silently multiply attempts; cross-provider ETag equality is never used as checksum verification.
- [x] Rollback only deletes with a supported exact precondition or an explicit exclusive-prefix policy; overwrites are not claimed reversible.
- [x] Raw errors, tokens, signed URLs, and bodies do not enter journal diagnostics.
- [x] Unsupported metadata fails unless explicitly omitted; native-only attributes and case-insensitive filename collisions have documented policies.

## Blocked by

[01: package and Effect boundary](01-package-and-effect-boundary.md).
Use [02](02-object-source.md)'s reference schema for the final transfer signature.

## Comments

Implemented on 2026-10-16 in `packages/files-sdk`. See the parent PRD and package
README for validation and advisory-store operating limits. Live cloud
qualification is explicitly separate from credential-free acceptance.

2026-10-16 review fix: transfers now take content type and custom metadata from
the validated download, rather than potentially incomplete listing descriptors.
A regression test simulates S3 listing omissions and covers default preservation,
explicit preservation, and explicit omission. Copy-journal validator enrichment
remains a separate review finding pending discussion of guarded rollback.

2026-10-16 follow-up: copy journaling now includes observed destination size and
available ETag after successful metadata retrieval. A finalizer retains one
minimal copy entry if that retrieval fails or is interrupted. Guarded rollback
tests pass the journaled ETag to native conditional deletion, verify unchanged
files can be removed, and preserve replacements and Migration Item State on
ETag mismatch. Documentation includes the composition and missing-ETag handling.
