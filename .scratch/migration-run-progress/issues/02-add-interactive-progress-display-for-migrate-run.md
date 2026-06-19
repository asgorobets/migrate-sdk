# Add Interactive Progress Display for Migrate Run

Status: ready-for-agent

## Parent

[Migration Run Progress](../PRD.md)

## What to build

Add the interactive terminal progress display for `migrate run` using the progress state introduced by the checkpoint log slice. In an interactive TTY, the CLI should render a compact live progress display while preserving the final `MigrationRunSummary` as the authoritative completion output.

This slice should focus on readable human feedback: active Migration Definition, processed Source Item count, outcome counters, Source Cursor Window progress, and clean terminal behavior on success or failure.

## Acceptance criteria

- [ ] Interactive `migrate run` renders live progress by default when the output is a TTY.
- [ ] The progress display shows the active Migration Definition.
- [ ] The progress display shows Source Items processed and relevant outcome counters as they update.
- [ ] The progress display handles unknown totals without showing a misleading percentage.
- [ ] `migrate run --all` displays progress for one active Migration Definition at a time in existing execution order.
- [ ] The final `MigrationRunSummary` remains visible and readable after progress completes.
- [ ] Failure output remains visible and readable when a run fails.
- [ ] `--progress none` still suppresses interactive progress.
- [ ] Non-TTY and CI-style output remains unchanged by the interactive renderer.
- [ ] Renderer tests cover success cleanup, failure cleanup, unknown-total display, and ordered `run --all` display behavior.

## Blocked by

- [Add Checkpoint Log Progress for Migrate Run](./01-add-checkpoint-log-progress-for-migrate-run.md)
