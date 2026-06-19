# Migration Run Progress

Status: done

## Problem Statement

Operators running migrations from the CLI currently see useful output before a run starts and a final `Migration Run Summary` after the run completes, but they do not get live feedback while Source Items are being processed. For large Source Cursor Windows or slow destination calls, the CLI can look idle even though the runtime is actively processing Source Items and recording Migration Item Outcomes.

The SDK needs an Effect-native way to surface live progress without turning progress into durable migration state. The Migration Store remains responsible for item state, run state, Source Cursor commits, source contracts, and summaries. CLI progress should be a live display that can be rendered or ignored without changing migration correctness.

## Solution

Add live progress display for `migrate run` and `migrate rollback`.

The runtime emits structured `MigrationProgressEvent` values through a `MigrationProgress` Effect service and structured `RollbackProgressEvent` values through a `RollbackProgress` Effect service. The default layers are no-ops so direct SDK usage does not need terminal wiring. The CLI provides progress layers that reduce events into `SubscriptionRef`-backed progress state. CLI renderers subscribe to that state and update transient progress displays while run or rollback execution is active.

`SubscriptionRef` is the implementation choice for this PRD because the CLI needs the latest aggregate state, not a durable replay of every progress event. `PubSub` and `Queue` are not part of this slice.

Progress is live observability:

- It is not persisted in `MigrationStore`.
- It is not a `Migration Diagnostic`.
- It is not a replacement for `MigrationRunSummary`.
- It does not expose raw Source Cursor values in public CLI output.
- It does not require Source plugins, Destination plugins, or Migration authors to adopt new APIs.

The `migrate run` CLI behavior is:

- Interactive TTY: render live progress to the terminal.
- Non-TTY, CI, or snapshot-oriented output: preserve current stable output and final summary behavior.
- `--progress none`: suppress live progress display.
- `--progress log`: emit line-oriented progress updates at run, definition, and Source Cursor Window checkpoints.
- `run --all`: render progress for the ordered definitions one at a time, matching existing execution order.

The `migrate rollback` CLI behavior is:

- Interactive TTY: render live rollback progress to the terminal.
- Non-TTY, CI, or snapshot-oriented output: preserve current stable output and final summary behavior.
- `--progress none`: suppress live rollback progress display.
- `--progress log`: emit line-oriented rollback updates at rollback, definition, and Source Item rollback checkpoints.
- `rollback --all`: render rollback progress in actual rollback execution order.

The final `MigrationRunSummary` remains the authoritative completion output.
The final `RollbackRunSummary` remains the authoritative rollback completion output.

## User Stories

1. As an operator running `migrate run`, I want to see that the migration is active, so that long runs do not look stalled.

2. As an operator, I want to see Source Items processed as they complete, so that I can understand run progress before the final summary.

3. As an operator, I want to see the active Migration Definition, so that I know which part of the registry is running.

4. As an operator, I want to see outcome counters update, so that failures and skipped items are visible during the run.

5. As an operator running `run --all`, I want progress to follow the current ordered definition execution, so that logs match the actual run order.

6. As an operator, I want the final `MigrationRunSummary` to remain visible and unchanged, so that existing run results stay authoritative.

7. As an operator in CI or a redirected shell, I want stable non-interactive output, so that logs and scripts are not polluted by terminal progress control characters.

8. As an operator, I want `--progress none`, so that I can suppress live progress when needed.

9. As an operator, I want `--progress log`, so that I can get line-oriented checkpoint progress in non-interactive logs.

## Implementation Decisions

- Add a small progress domain module that defines progress events and an aggregate state reducer.

- Add a `MigrationProgress` Effect service with an `emit` operation and a no-op default layer.

- Emit progress events from `migrate run` execution points that already exist: run start, definition start, Source Cursor Window read, item completed, definition complete, run complete, and run failure.

- Emit rollback progress events from rollback execution points that already exist: rollback start, definition start, item rollback completed, definition complete, rollback complete, and rollback failure.

- Use `SubscriptionRef` in the CLI progress layers. The renderer subscribes to the latest state and redraws from snapshots.

- Do not use `PubSub` or `Queue` for this PRD.

- Render live progress only for interactive TTY output by default. Preserve existing non-interactive output.

- Add `--progress none` and `--progress log` to the run and rollback commands.

- In `--progress log`, print aggregate progress lines at run start, definition start, Source Cursor Window completion, definition completion, run completion, and run failure. Do not print one line per Source Item by default.

- In rollback `--progress log`, print rollback progress lines at rollback start, definition start, Source Item rollback completion, definition completion, rollback completion, and rollback failure.

- In `run --all`, log progress for one active Migration Definition at a time. Do not interleave multiple definition progress streams because `run --all` currently executes ordered definitions sequentially.

- Do not add `--progress-batch-size`. Source `batchSize` already controls Source Cursor Window size, and log mode should naturally follow those windows.

- Keep the final `MigrationRunSummary` behavior unchanged.

- Keep the final `RollbackRunSummary` behavior unchanged.

- Keep raw Source Cursor values out of public progress output.

- Do not add a third-party progress-bar dependency in this slice.

## Testing Decisions

- Test runtime progress with recording progress layers and assert meaningful events and counts.

- Test the progress reducer as a pure unit.

- Test that non-TTY CLI runs preserve current summary output by default.

- Test `--progress none` and `--progress log` behavior.

- Test that run `--progress log` emits checkpoint lines rather than one line per Source Item.

- Test that rollback `--progress log` emits rollback Source Item progress without exposing raw Source Identity values.

- Test renderer cleanup on success and failure so final output remains readable.

- Do not add Migration Store schema tests because progress is not durable store state.

## Out of Scope

Durable progress persistence in `MigrationStore`.

Item-level diagnostic or journal browsing in the status command.

Public exposure of raw Source Cursor values.

Adding a third-party progress-bar dependency.

Batching, concurrent execution, telemetry fan-out, remote dashboards, or multi-process progress streaming.

Interleaved progress output for multiple active Migration Definitions.

Separate progress logging cadence flags, such as `--progress-log-every`.

Changing the final `MigrationRunSummary` or `RollbackRunSummary` contract.

## Further Notes

This PRD is intentionally limited to concise CLI progress display for `migrate run` and `migrate rollback`.
