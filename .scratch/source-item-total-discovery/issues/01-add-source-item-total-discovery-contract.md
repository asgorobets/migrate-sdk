# Add Source Item Total Count Contract

Status: ready-for-human
Type: AFK

## Parent

[Optional Source Item Total Count](../PRD.md)

## What to build

Add the shared contract for optional Source Item total count and carry its result through runtime progress state. This slice should make known, lower-bound, and unknown totals first-class without adding native total logic to the existing first-party source plugins yet.

The contract must preserve today's source authoring path: a source plugin can omit total count and still run normally. When a progress consumer asks for totals, the runtime should call `countTotal` at Migration Definition start when it exists, store the result for that active definition, and degrade missing or failed counts to unknown progress.

Covers user stories 1-8, 13, 16-22, and 25.

## Acceptance criteria

- [x] A shared Source Item total type exists with explicit known, lower-bound, and unknown variants.
- [x] Known totals accept non-negative integers, including zero.
- [x] Lower-bound totals accept non-negative integer minimums and preserve a reason category such as capped.
- [x] Unknown totals carry a reason category suitable for progress rendering, such as unsupported, disabled, too expensive, or failed.
- [x] Total count is optional on the configured source plugin contract.
- [x] Existing source plugins without total count continue to compile and run.
- [x] Total count is separate from Source Cursor Window reads and source identity lookup.
- [x] The runtime only calls total count when a progress consumer needs it.
- [x] The default no-op progress path does not trigger total count.
- [x] Total count failure becomes an unknown total and a progress warning instead of failing the migration run.
- [x] Progress state stores total state per active Migration Definition, including `run --all` cases.
- [x] Progress state never derives percentage, remaining count, or completion ratio from a lower-bound or unknown total.
- [x] Run limits cap the effective total shown by progress state when the counted total is larger than the active run limit, including lower bounds that satisfy the limit.
- [x] Total count does not read or write Migration Item State, Migration Run State, Migration Diagnostics, persisted Source Cursor progress, or Migration Definition locks.
- [x] Durable-only status does not initialize source plugins for total count.
- [x] Source Inventory Scan remains independent and continues to compute inventory totals by scanning.
- [x] Tests cover known zero, known positive, lower-bound, unsupported unknown progress, omitted capability, known count, count failure, no-op progress, run-limit capping, and `run --all` scoping.

## Blocked by

None - can start immediately

## Completion notes

Implemented in the Source Item total domain type, optional configured source plugin capability, migration progress opt-in flag, runtime total-count event emission, and progress reducer state. The contract accepts existing numeric totals and richer Source Item total values for native lower-bound cases. Native first-party source totals remain for the follow-up plugin tickets.
