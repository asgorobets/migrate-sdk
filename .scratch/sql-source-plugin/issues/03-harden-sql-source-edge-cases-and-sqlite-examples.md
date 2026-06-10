# Harden SQL Source Edge Cases And SQLite Examples

Status: ready-for-human

## Parent

[SQL Source Plugin](../PRD.md)

## What to build

Harden the off-happy-path SQL source behavior and add realistic examples/tests using a local SQLite-style test database. This slice should prove that the SQL source handles bad metadata, ambiguous lookup results, duplicate identities, bad pagination configuration, and keyset pagination examples in ways that match the documented Source Item and Source Cursor contracts.

The examples should demonstrate how a migration author writes deterministic keyset SQL, lookup-by-identity SQL, Source Version extraction, and Source Cursor extraction against a local database without relying on offset pagination.

## Acceptance criteria

- [x] `batchSize` is validated as a positive integer.
- [x] Read windows fail when metadata extraction returns a Result error.
- [x] Lookup fails when metadata extraction returns a Result error.
- [x] Read windows fail when metadata extraction cannot produce a Source Cursor for a returned row.
- [x] Read windows reject duplicate Source Identities within the same returned window after normal Source Identity input normalization.
- [x] Lookup fails when the executed statement returns more than one row.
- [x] Lookup fails when the returned row's extracted Source Identity does not match the requested Source Identity after normalization.
- [x] Duplicate detection across different cursor windows remains out of scope for the SQL source plugin.
- [x] The source does not issue `limit + 1` probes.
- [x] The source does not expose or require first-class offset pagination.
- [x] A local SQLite-style test database exercises keyset pagination over at least two read windows.
- [x] A real in-memory SQLite smoke test exercises the Effect SQL SQLite client boundary.
- [x] The local SQLite-style and real SQLite tests exercise direct lookup by Source Identity.
- [x] The example or tests show Source Version and Source Cursor as related but separate signals.
- [x] The example or tests show the lookup query as identity-unique without relying on `LIMIT 1`.
- [x] The example or tests show the read query applying the provided `limit`.
- [x] The example or tests show deterministic ordering with a stable tie-breaker.
- [x] Authoring docs or examples are updated only where edge-case behavior is proven by this slice.
- [x] Existing SQL source happy-path tests from issue 02 remain green.

## Blocked by

- [02 - Implement SQL Source Read And Lookup Happy Path](02-implement-sql-source-read-and-lookup-happy-path.md)
