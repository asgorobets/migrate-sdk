# Add Checkpoint Log Progress for Migrate Run

Status: done

## Parent

[Migration Run Progress](../PRD.md)

## What to build

Add the first end-to-end progress slice for `migrate run`: the runtime emits live Migration Progress events, the CLI reduces those events into a `SubscriptionRef`-backed progress state, and `--progress log` renders line-oriented checkpoint progress.

This slice should make progress observable without adding interactive terminal rendering yet. It should preserve existing default output in non-interactive execution, keep progress out of durable Migration Store state, and keep Source Cursor values out of public output.

## Acceptance criteria

- [x] `migrate run --progress log` emits line-oriented progress for run start, Migration Definition start, Source Cursor Window completion, Migration Definition completion, run completion, and run failure.
- [x] Progress log lines include aggregate counts that make Source Item processing visible before the final `MigrationRunSummary`.
- [x] Progress log lines include the active Migration Definition when a run contains multiple definitions.
- [x] `migrate run --all --progress log` logs one active Migration Definition at a time in existing execution order.
- [x] `--progress log` does not emit one line per Source Item by default.
- [x] `migrate run --progress none` suppresses live progress output.
- [x] Default non-TTY and CI-style `migrate run` output remains stable and continues to render the final `MigrationRunSummary`.
- [x] Progress events are emitted through an Effect service with a no-op default layer.
- [x] The CLI progress layer uses `SubscriptionRef` to hold aggregate progress state.
- [x] Progress is not persisted in `MigrationStore` and does not introduce store schema changes.
- [x] Public progress output does not include raw Source Cursor values.
- [x] Tests cover runtime progress emission with a recording progress service.
- [x] Tests cover progress state reduction separately from CLI output.
- [x] Tests cover `--progress log`, `--progress none`, default non-interactive output, and ordered `run --all` log output.

## Blocked by

None - can start immediately
