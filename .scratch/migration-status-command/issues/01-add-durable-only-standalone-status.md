# Add Durable-Only Standalone Status

Status: ready-for-agent

## Parent

[Migration Status Command](../PRD.md)

## What to build

Add the first status tracer bullet for SDK callers that already have Migration Definitions. The standalone status API should return structured durable progress for selected definitions without constructing a registry, initializing plugins, acquiring locks, creating run state, advancing cursors, or touching destination-side behavior.

This slice proves the status domain shapes, request normalization, serializable warnings, durable Migration Store read primitives, and durable-only report construction through public SDK/runtime tests.

## Acceptance criteria

- [ ] A standalone status API accepts supplied Migration Definitions and returns a structured status report.
- [ ] Standalone status can filter supplied definitions by explicit definition ids.
- [ ] Standalone status rejects unknown selected definition ids with a typed status error.
- [ ] Standalone status does not expand dependencies.
- [ ] Status request normalization defaults source scanning to disabled.
- [ ] Status request normalization defaults scan concurrency to one.
- [ ] Status request validation rejects non-positive concurrency.
- [ ] Status request validation rejects non-integer concurrency.
- [ ] Status request validation rejects concurrency when source scanning is disabled.
- [ ] Status report data is represented by migration-specific public domain types, separate from run summaries.
- [ ] Status warnings are represented as schema-backed serializable data.
- [ ] Status warnings do not use the Effect error channel.
- [ ] Status errors remain typed Effect errors.
- [ ] Migration Store exposes a latest-run-state read primitive for status.
- [ ] Migration Store exposes an item-state-summary read primitive for status.
- [ ] In-memory store implements latest-run-state reads.
- [ ] In-memory store implements item-state-summary reads.
- [ ] File store implements latest-run-state reads.
- [ ] File store implements item-state-summary reads.
- [ ] Missing latest run state returns null or an equivalent empty value rather than failing.
- [ ] Item-state summaries count migrated states.
- [ ] Item-state summaries count skipped states.
- [ ] Item-state summaries count failed states.
- [ ] Item-state summaries count needs-update states.
- [ ] Item-state summaries do not expose unchanged counts.
- [ ] Item-state summaries do not expose rollbackable counts.
- [ ] Durable-only status reads latest run lifecycle metadata.
- [ ] Durable-only status reads current durable item-state counts.
- [ ] Durable-only status keeps latest run lifecycle metadata separate from current item-state counts.
- [ ] Durable-only status does not initialize source plugins.
- [ ] Durable-only status does not initialize destination plugins.
- [ ] Durable-only status does not acquire Migration Definition Locks.
- [ ] Durable-only status does not create Migration Run State.
- [ ] Durable-only status does not read persisted Source Cursor progress.
- [ ] Durable-only status does not write Source Cursor progress.
- [ ] Durable-only status does not write Migration Item State.
- [ ] Durable-only status does not execute migration pipelines.
- [ ] Durable-only status does not call destination command execution.
- [ ] Tests cover request normalization and invalid request cases.
- [ ] Tests cover status warning schema encode/decode.
- [ ] Tests cover durable-only status behavior through public SDK/runtime APIs.
- [ ] Tests cover file and in-memory store summary behavior.

## Blocked by

None - can start immediately.
