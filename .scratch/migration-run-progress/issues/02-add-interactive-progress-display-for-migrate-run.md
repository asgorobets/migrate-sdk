# Add Interactive Progress Display for Migrate Run

Status: done

## Parent

[Migration Run Progress](../PRD.md)

## What to build

Add the interactive terminal progress display for `migrate run` using the progress state introduced by the checkpoint log slice. In an interactive TTY, the CLI should render a compact live progress display while preserving the final `MigrationRunSummary` as the authoritative completion output.

This slice should focus on readable human feedback: active Migration Definition, processed Source Item count, outcome counters, Source Cursor Window progress, and clean terminal behavior on success or failure.

## Acceptance criteria

- [x] Interactive `migrate run` renders live progress by default when the output is a TTY.
- [x] The progress display shows the active Migration Definition.
- [x] The progress display shows Source Items processed and relevant outcome counters as they update.
- [x] The progress display handles unknown totals without showing a misleading percentage.
- [x] `migrate run --all` displays progress for one active Migration Definition at a time in existing execution order.
- [x] The final `MigrationRunSummary` remains visible and readable after progress completes.
- [x] Failure output remains visible and readable when a run fails.
- [x] `--progress none` still suppresses interactive progress.
- [x] Non-TTY and CI-style output remains unchanged by the interactive renderer.
- [x] Renderer tests cover success cleanup, failure cleanup, unknown-total display, and ordered `run --all` display behavior.

## Blocked by

None - dependency completed
