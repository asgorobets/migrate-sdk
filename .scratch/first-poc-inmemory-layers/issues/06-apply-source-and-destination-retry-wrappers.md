# Apply source and destination retry wrappers

Status: done

## Parent

[First POC: In-Memory Migration Runtime](../PRD.md)

## What to build

Add optional retry wrappers selected by the Migration Definition for Source Cursor reads, Source Identity lookups, and Destination Command execution. The in-memory layers should allow deterministic transient failures so retry behavior can be tested without wall-clock sleeps.

## Acceptance criteria

- [x] Migration Definitions can provide a Source Cursor Retry Strategy.
- [x] Migration Definitions can provide a Source Lookup Retry Strategy.
- [x] Migration Definitions can provide a Destination Retry Strategy.
- [x] Source cursor reads are wrapped by the Source Cursor Retry Strategy when configured.
- [x] Source identity lookups are wrapped by the Source Lookup Retry Strategy when configured.
- [x] Destination Command execution is wrapped by the Destination Retry Strategy when configured.
- [x] Tests verify retries with deterministic counters or schedules, not real-time delays.

## Blocked by

- [02 - Process cursor windows and Source Version changes](02-process-cursor-windows-and-source-version-changes.md)
- [03 - Persist Skip Item and item failures](03-persist-skip-item-and-item-failures.md)
