# Render CLI Progress Bars For Known Totals

Status: ready-for-human
Type: AFK

## Parent

[Optional Source Item Total Count](../PRD.md)

## What to build

Add CLI progress rendering that uses known Source Item totals when the runtime provides them, while preserving honest unknown-total progress output.

The CLI currently has progress output but no progress bar. This slice should add determinate progress bars only for known totals. Unknown totals should continue to show activity, processed count, outcome counters, and Source Cursor Window checkpoints without percentages, ETAs, or `x / y` completion claims.

Covers user stories 1-7 and 22-25.

## Acceptance criteria

- [x] Interactive CLI progress renders a determinate progress bar when the active Migration Definition has a known total.
- [x] Interactive CLI progress renders processed count, total count, and percentage only for known totals.
- [x] Interactive CLI progress handles known zero totals without divide-by-zero behavior or misleading percentages.
- [x] Interactive CLI progress for unknown totals avoids progress bars, percentages, ETAs, and `x / y` total displays.
- [x] Unknown-total progress still shows active Migration Definition, processed Source Items, outcome counters, and activity/checkpoint information.
- [x] `--progress log` includes total information only when the total is known.
- [x] `--progress log` remains concise and stable for unknown totals.
- [x] Source Cursor Window checkpoint output does not expose raw Source Cursor values or source-native pagination tokens.
- [x] Non-TTY default output remains stable.
- [x] `--progress none` avoids total count unless another explicit progress consumer requests it.
- [x] Success and failure cleanup leave terminal output readable.
- [x] `run --all` resets known or unknown total display for each active Migration Definition.
- [x] No third-party progress bar dependency is added.
- [x] Tests cover known totals, unknown totals, zero totals, `--progress log`, non-TTY output, `--progress none`, success cleanup, and failure cleanup.

## Blocked by

[Add Source Item Total Count Contract](./01-add-source-item-total-discovery-contract.md)

## Completion notes

- CLI log and interactive progress providers now opt in to Source Item total count.
- Known totals render a fixed-width ASCII progress bar with processed count, total count, and percentage.
- Unknown totals keep the existing indeterminate activity output with no bar, percentage, ETA, or `x / y` display.
- `--progress none` remains count-free.
- Verified with `pnpm --filter migrate-sdk check-types`, `pnpm --filter migrate-sdk test -- migrate-cli.test.ts -t progress`, `pnpm exec ultracite check packages/migrate-sdk/src/cli/progress.ts packages/migrate-sdk/src/cli/migrate-cli.test.ts`, `pnpm --filter migrate-sdk test`, and `git diff --check`.
