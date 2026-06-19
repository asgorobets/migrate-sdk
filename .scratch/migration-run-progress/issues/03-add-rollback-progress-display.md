# Add Rollback Progress Display

Status: done

## Parent

[Migration Run Progress](../PRD.md)

## What to build

Add live progress display for `migrate rollback` with behavior that matches the progress controls already available for `migrate run`. Operators should be able to see rollback activity while item state is being rolled back, without changing rollback correctness or making progress durable migration state.

This follow-up intentionally expands the original progress scope, which treated rollback progress as out of scope. The rollback CLI should expose the same progress modes as run execution: default interactive display in a TTY, stable output in non-TTY and CI-style output, `--progress log` for line-oriented checkpoint logs, and `--progress none` to suppress live progress.

The display should focus on rollback-specific language and counters: active Migration Definition, rolled-back Source Item count, skipped count, failed count, and clean terminal behavior before the final `RollbackRunSummary`.

## Acceptance criteria

- [x] `migrate rollback` accepts the same `--progress auto|log|none` flag shape as `migrate run`.
- [x] Interactive `migrate rollback` renders live progress by default when the output is a TTY.
- [x] `migrate rollback --progress log` emits line-oriented rollback checkpoint progress for rollback start, Migration Definition start, item rollback progress, Migration Definition completion, rollback completion, and rollback failure.
- [x] `migrate rollback --progress none` suppresses rollback progress output.
- [x] Default non-TTY and CI-style rollback output remains stable and continues to render the final `RollbackRunSummary`.
- [x] The progress display shows the active Migration Definition.
- [x] The progress display shows rollback-specific counters as they update: rolled back, skipped, and failed.
- [x] Rollback progress follows existing rollback execution order, including dependency-expanded rollback order.
- [x] Targeted rollback by Source Identity shows progress for the selected Migration Definition without exposing raw internal cursor values.
- [x] The final `RollbackRunSummary` remains visible and readable after rollback progress completes.
- [x] Failure output remains visible and readable when rollback fails.
- [x] Rollback progress is emitted through an Effect service with a no-op default layer for direct SDK usage.
- [x] Rollback progress is not persisted in `MigrationStore` and does not introduce store schema changes.
- [x] Tests cover runtime rollback progress emission with a recording progress service.
- [x] Tests cover rollback progress state reduction separately from CLI output.
- [x] CLI tests cover `--progress log`, `--progress none`, default non-interactive output, interactive cleanup on success, interactive cleanup on failure, dependency-expanded rollback order, and targeted rollback progress.

## Blocked by

None - run progress slices completed
