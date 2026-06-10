# Add Durable-Only Standalone Status

Status: done

## Parent

[Migration Status Command](../PRD.md)

## What to build

Add the first status tracer bullet for SDK callers that already have Migration Definitions. The standalone status API should return structured durable progress for selected definitions without constructing a registry, initializing plugins, acquiring locks, creating run state, advancing cursors, or touching destination-side behavior.

This slice proves the status domain shapes, request normalization, serializable warnings, durable Migration Store read primitives, and durable-only report construction through public SDK/runtime tests.

## Acceptance criteria

- [x] A standalone status API accepts supplied Migration Definitions and returns a structured status report.
- [x] Standalone status can filter supplied definitions by explicit definition ids.
- [x] Standalone status rejects unknown selected definition ids with a typed status error.
- [x] Standalone status does not expand dependencies.
- [x] Status request normalization defaults source scanning to disabled.
- [x] Status request normalization defaults scan concurrency to one.
- [x] Status request validation rejects non-positive concurrency.
- [x] Status request validation rejects non-integer concurrency.
- [x] Status request validation rejects concurrency when source scanning is disabled.
- [x] Status report data is represented by migration-specific public domain types, separate from run summaries.
- [x] Status warnings are represented as schema-backed serializable data.
- [x] Status warnings do not use the Effect error channel.
- [x] Status errors remain typed Effect errors.
- [x] Migration Store exposes a latest-run-state read primitive for status.
- [x] Migration Store exposes an item-state-summary read primitive for status.
- [x] In-memory store implements latest-run-state reads.
- [x] In-memory store implements item-state-summary reads.
- [x] File store implements latest-run-state reads.
- [x] File store implements item-state-summary reads.
- [x] Missing latest run state returns null or an equivalent empty value rather than failing.
- [x] Item-state summaries count migrated states.
- [x] Item-state summaries count skipped states.
- [x] Item-state summaries count failed states.
- [x] Item-state summaries count needs-update states.
- [x] Item-state summaries do not expose unchanged counts.
- [x] Item-state summaries do not expose rollbackable counts.
- [x] Durable-only status reads latest run lifecycle metadata.
- [x] Durable-only status reads current durable item-state counts.
- [x] Durable-only status keeps latest run lifecycle metadata separate from current item-state counts.
- [x] Durable-only status does not initialize source plugins.
- [x] Durable-only status does not initialize destination plugins.
- [x] Durable-only status does not acquire Migration Definition Locks.
- [x] Durable-only status does not create Migration Run State.
- [x] Durable-only status does not read persisted Source Cursor progress.
- [x] Durable-only status does not write Source Cursor progress.
- [x] Durable-only status does not write Migration Item State.
- [x] Durable-only status does not execute migration pipelines.
- [x] Durable-only status does not call destination command execution.
- [x] Tests cover request normalization and invalid request cases.
- [x] Tests cover status warning schema encode/decode.
- [x] Tests cover durable-only status behavior through public SDK/runtime APIs.
- [x] Tests cover file and in-memory store summary behavior.

## Blocked by

None - can start immediately.
