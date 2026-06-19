# Add Source Item Total Discovery Contract

Status: ready-for-agent
Type: AFK

## Parent

[Optional Source Item Total Discovery](../PRD.md)

## What to build

Add the shared contract for optional Source Item total discovery and carry its result through runtime progress state. This slice should make known and unknown totals first-class without adding native total logic to the existing first-party source plugins yet.

The contract must preserve today's source authoring path: a source plugin can omit total discovery and still run normally. When a progress consumer asks for totals, the runtime should attempt discovery at Migration Definition start, store the result for that active definition, and degrade failures to unknown progress.

Covers user stories 1-8, 13, 16-22, and 25.

## Acceptance criteria

- [x] A shared Source Item total type exists with explicit known and unknown variants.
- [x] Known totals accept non-negative integers, including zero.
- [x] Unknown totals carry a reason category suitable for progress rendering, such as unsupported, disabled, too expensive, or failed.
- [x] Total discovery is optional on the configured source plugin contract.
- [x] Existing source plugins without total discovery continue to compile and run.
- [x] Total discovery is separate from Source Cursor Window reads and source identity lookup.
- [x] The runtime only calls total discovery when a progress consumer needs it.
- [x] The default no-op progress path does not trigger total discovery.
- [x] Total discovery failure becomes an unknown total and a progress warning instead of failing the migration run.
- [x] Progress state stores total state per active Migration Definition, including `run --all` cases.
- [x] Progress state never derives percentage, remaining count, or completion ratio from an unknown total.
- [x] Run limits cap the effective total shown by progress state when the discovered total is larger than the active run limit.
- [x] Total discovery does not read or write Migration Item State, Migration Run State, Migration Diagnostics, persisted Source Cursor progress, or Migration Definition locks.
- [x] Durable-only status does not initialize source plugins for total discovery.
- [x] Source Inventory Scan remains independent and continues to compute inventory totals by scanning.
- [x] Tests cover known zero, known positive, unknown, omitted capability, known discovery, unknown discovery, discovery failure, no-op progress, run-limit capping, and `run --all` scoping.

## Blocked by

None - can start immediately

## Completion notes

Implemented in the Source Item total domain type, optional configured source plugin capability, migration progress opt-in flag, runtime discovery event emission, and progress reducer state. Native first-party source totals remain for the follow-up plugin tickets.
