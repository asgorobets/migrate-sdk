# Add Configurable Pipeline Execution Concurrency

Status: ready-for-human

## Parent

.scratch/pipeline-execution-concurrency/PRD.md

## What to build

Add configurable Pipeline Execution concurrency for the current inline runtime, end to end.

Migration operators and SDK callers should be able to run Process Pipelines and Rollback Pipelines with a positive bounded concurrency value or with an explicit `"unbounded"` setting. Serial execution must remain the default. Request-level overrides, including CLI flags, should take precedence over Migration Definition defaults, and Migration Definition defaults should take precedence over the runtime default.

The runtime must keep Migration Definition execution ordered by dependencies, keep Source Cursor Window reads sequential, and commit each next Source Cursor only after all Source Items in that window have settled. Parallel item execution must preserve one Pipeline Execution Scope per Source Item or Rollbackable Migration Item State, keep destination journals and staged tracking records item-local, and keep Migration Run Summary and Rollback Run Summary contracts unchanged.

The CLI should expose a shared command-local `--concurrency` / `-c` flag for run, rollback, and status while preserving each command's distinct internal meaning. Plan output should show the effective execution policy so operators can confirm destination pressure before running.

## Acceptance criteria

- [x] SDK/domain request types accept normalized execution options for process and rollback concurrency.
- [x] Migration Definitions may declare process and rollback execution defaults.
- [x] Effective concurrency resolves in this order: request or CLI override, Migration Definition default, runtime default `1`.
- [x] Concurrency accepts positive integers and `"unbounded"`; invalid values fail before run state, locks, source reads, destination work, or rollback work starts.
- [x] Forward Migration Runs process item work with the effective process concurrency while keeping Migration Definitions ordered sequentially.
- [x] Source Cursor Window reads remain sequential, and the next Source Cursor is committed only after all items in the current window settle.
- [x] Targeted, failed, skipped, and needs-update run modes preserve existing behavior while using the normalized execution policy where applicable.
- [x] Rollback runs process rollbackable item states with the effective rollback concurrency while preserving reverse dependency order.
- [x] Successful rollback still deletes item state, and failed rollback still preserves item state with failed rollback attempt evidence.
- [x] Per-item Pipeline Execution Scope, Tracking service state, destination journal evidence, and staged tracking records remain isolated per Source Item or Rollbackable Migration Item State.
- [x] Concurrent item outcomes aggregate into accurate Migration Run Summary and Rollback Run Summary counts.
- [x] Migration Store failures still fail the definition run rather than becoming item failures.
- [x] Registry run and rollback helpers pass execution options through after planning.
- [x] CLI exposes `--concurrency <n|unbounded>` / `-c <n|unbounded>` for run and rollback.
- [x] CLI plan output shows the effective process or rollback execution policy.
- [x] Existing status `--concurrency` / `-c` behavior remains source-scan-only even though the public flag name is shared with run and rollback.
- [x] Tests cover execution policy normalization, bounded process concurrency, unbounded process concurrency, rollback concurrency, Source Cursor Window commit timing, concurrent failure aggregation, CLI parsing, and status concurrency isolation.

## Blocked by

None - can start immediately.
