# Render CLI Progress Bars For Known Totals

Status: ready-for-agent
Type: AFK

## Parent

[Optional Source Item Total Discovery](../PRD.md)

## What to build

Add CLI progress rendering that uses known Source Item totals when the runtime provides them, while preserving honest unknown-total progress output.

The CLI currently has progress output but no progress bar. This slice should add determinate progress bars only for known totals. Unknown totals should continue to show activity, processed count, outcome counters, and Source Cursor Window checkpoints without percentages, ETAs, or `x / y` completion claims.

Covers user stories 1-7 and 22-25.

## Acceptance criteria

- [ ] Interactive CLI progress renders a determinate progress bar when the active Migration Definition has a known total.
- [ ] Interactive CLI progress renders processed count, total count, and percentage only for known totals.
- [ ] Interactive CLI progress handles known zero totals without divide-by-zero behavior or misleading percentages.
- [ ] Interactive CLI progress for unknown totals avoids progress bars, percentages, ETAs, and `x / y` total displays.
- [ ] Unknown-total progress still shows active Migration Definition, processed Source Items, outcome counters, and activity/checkpoint information.
- [ ] `--progress log` includes total information only when the total is known.
- [ ] `--progress log` remains concise and stable for unknown totals.
- [ ] Source Cursor Window checkpoint output does not expose raw Source Cursor values or source-native pagination tokens.
- [ ] Non-TTY default output remains stable.
- [ ] `--progress none` avoids total discovery unless another explicit progress consumer requests it.
- [ ] Success and failure cleanup leave terminal output readable.
- [ ] `run --all` resets known or unknown total display for each active Migration Definition.
- [ ] No third-party progress bar dependency is added.
- [ ] Tests cover known totals, unknown totals, zero totals, `--progress log`, non-TTY output, `--progress none`, success cleanup, and failure cleanup.

## Blocked by

[Add Source Item Total Discovery Contract](./01-add-source-item-total-discovery-contract.md)
