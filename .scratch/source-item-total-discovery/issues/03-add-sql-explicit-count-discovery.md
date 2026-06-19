# Add SQL Explicit Count Discovery

Status: ready-for-agent
Type: AFK

## Parent

[Optional Source Item Total Discovery](../PRD.md)

## What to build

Add SQL source total discovery through an explicit migration-author-provided count operation. The SDK should not infer totals by rewriting arbitrary read SQL, removing limits, or interpreting cursor predicates.

The count operation should use the same SQL dependency model as SQL reads while remaining a separate operation from read and lookup. Failures degrade to unknown progress.

Covers user stories 2-8, 14-16, 18-19, and 23-24.

## Acceptance criteria

- [x] SQL source options support an explicit count statement or count effect for Source Item total discovery.
- [x] The count operation uses the same `SqlClient` requirement pattern as SQL reads.
- [x] Plugin-local dependency provisioning continues to work for SQL count discovery.
- [x] The SDK does not derive SQL totals by rewriting the configured read statement.
- [x] The SDK does not remove author-provided limits, infer cursor predicates, or parse arbitrary SQL to create a count query.
- [x] A successful count maps to a known non-negative Source Item total, including zero.
- [x] The count operation is expected to match the same author-configured source scope as the migration read.
- [x] SQL count failures return a typed unknown total and progress warning.
- [x] SQL count failures do not fail the migration run and do not write Migration Item State or Migration Diagnostics.
- [x] Total discovery does not call the configured SQL read or identity lookup operations.
- [x] Public exports expose only the intended SQL total-discovery API.
- [x] Tests cover known SQL count, zero count, count failure, dependency provisioning, no read/lookup calls, and no SQL rewriting behavior.

## Blocked by

[Add Source Item Total Discovery Contract](./01-add-source-item-total-discovery-contract.md)

## Completion note

Implemented explicit SQL `count` support with statement and Effect variants. Count discovery uses the same `SqlClient` dependency as SQL reads, remains separate from read/lookup, returns known non-negative totals for successful counts, returns disabled unknown when not configured, and degrades count failures to unknown failed progress while normal migration execution continues.
