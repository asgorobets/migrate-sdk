# Pipeline Execution Concurrency

Status: ready-for-agent

## Problem Statement

Migration operators can already choose which Migration Definitions to run, inspect an execution plan, and control Source Inventory Scan concurrency for status. They cannot control actual Migration Run or rollback throughput. The inline runtime currently executes Process Pipeline and Rollback Pipeline work one item at a time, even when each item performs independent destination-side Effect work and the destination system can safely handle more pressure.

This makes large migrations and rollbacks slower than necessary. Operators either wait for serial execution or push concurrency into ad hoc migration-author code, where it cannot respect runtime-owned item state, Pipeline Execution Scope, Source Cursor commits, rollback evidence, or summary aggregation. The runtime should own item-level scheduling because it already owns the durable migration ledger.

Operators need a direct way to trade destination pressure for runtime speed while keeping conservative defaults, predictable failure handling, and the existing Migration Definition dependency order.

## Solution

Add configurable execution concurrency to the inline Execution Adapter for Process Pipeline and Rollback Pipeline item work.

The runtime accepts a normalized pipeline execution policy. The policy supports a positive integer for bounded concurrency and `"unbounded"` for explicit unlimited concurrency. The default remains `1`.

Effective concurrency is resolved in this order:

- Run or rollback request override, including CLI flags.
- Migration Definition default, when one is declared.
- Runtime default of `1`.

The CLI exposes one command-local operator-facing concurrency flag. The flag name is shared, but each command maps it to its own execution concern:

- `migrate run ... --concurrency <n|unbounded>` / `migrate run ... -c <n|unbounded>`
- `migrate rollback ... --concurrency <n|unbounded>` / `migrate rollback ... -c <n|unbounded>`
- `migrate status --scan-source ... --concurrency <n>` / `migrate status --scan-source ... -c <n>`

Migration Definitions continue to run in dependency order. This feature parallelizes item work inside one locked Migration Definition; it does not run dependency-ordered definitions in parallel.

Forward execution keeps Source Cursor Window reads sequential. After a window is read, the runtime may process the Source Items in that window concurrently under the effective process concurrency policy. The next Source Cursor is committed only after the whole window settles, preserving the existing cursor-window durability model.

Rollback execution keeps Migration Definitions in reverse dependency order. Within one definition, rollbackable item states may be processed concurrently under the effective rollback concurrency policy. Successful rollback still deletes item state, and failed rollback still preserves item state with failed rollback attempt evidence.

## User Stories

1. As a migration operator, I want to run Process Pipelines with bounded concurrency, so that large migrations finish faster without overwhelming destination systems.

2. As a migration operator, I want rollback to support bounded concurrency, so that recovery and cleanup work can complete in practical time for large runs.

3. As a migration operator, I want concurrency to default to one, so that existing runs stay conservative unless I intentionally raise throughput.

4. As a migration operator, I want an explicit unbounded option, so that I can use maximum throughput in controlled environments.

5. As a migration operator, I want CLI flags for run and rollback concurrency, so that I can tune one execution without changing migration code.

6. As a migration author, I want a Migration Definition default concurrency, so that definitions with known destination limits can encode a safe baseline for operators.

7. As a migration operator, I want Source Cursor Window commits to remain safe, so that parallel item processing cannot skip or lose source progress.

8. As a migration operator, I want final summaries and item failures to stay accurate under concurrency, so that faster execution does not reduce operational trust.

## Implementation Decisions

- Add a small execution policy domain module that defines pipeline concurrency, validates request input, resolves request overrides against Migration Definition defaults, and exposes normalized runtime options.

- The concurrency value must be either a positive integer or `"unbounded"`. Invalid values fail before any run state, lock acquisition, source reads, destination work, or rollback work starts.

- Add optional execution defaults to Migration Definitions. Process and rollback defaults are separate because safe throughput can differ between forward destination writes and compensating cleanup.

- Add execution options to Run Requests and Rollback Requests. The registry run and rollback helpers pass these options through after planning.

- Add command-local CLI flags for run, rollback, and status. Reuse the `--concurrency` / `-c` name at the command boundary while preserving separate internal meanings: Process Pipeline concurrency for run, Rollback Pipeline concurrency for rollback, and Source Inventory Scan concurrency for status.

- Keep ordered Migration Definition execution sequential. Required and optional dependency ordering remains unchanged.

- Keep Source Cursor Window reads sequential for each Migration Definition. Concurrency applies to item work inside a read window, not to multiple cursor reads in parallel.

- Commit a Source Cursor only after every item in the window has completed with a Migration Item Outcome or failed through the existing definition-level error path.

- Process failed, skipped, needs-update, and targeted source identity work through the same normalized execution policy where doing so does not change source cursor semantics.

- Replace shared mutable count updates in item loops with per-item outcomes that are aggregated after concurrent work settles.

- Keep `processSourceItem` and rollback item execution responsible for one item at a time. Their public meaning does not change; scheduling sits one layer above them.

- Preserve one Pipeline Execution Scope per Source Item or Rollbackable Migration Item State. Tracking service instances, destination journals, and staged tracking records stay item-local.

- Store writes for different source identities may happen concurrently within one owned Migration Definition lock. Store implementations must preserve correctness for independent item-state writes and deletes under that condition.

- Preserve the final Migration Run Summary and Rollback Run Summary shapes. Concurrency changes runtime throughput, not summary contracts.

- Plan rendering should show effective run or rollback concurrency when a command is invoked with `--plan`, so operators can confirm the execution pressure before running.

## Testing Decisions

- Test the execution policy normalization as a deep module: default `1`, valid positive integers, valid `"unbounded"`, invalid zero, invalid negative values, invalid fractions, and invalid strings.

- Test runtime process concurrency with Effect test probes that block active item work and prove the maximum active Process Pipeline count respects the configured bound.

- Test unbounded process concurrency with enough items to prove more than the bounded default can run simultaneously.

- Test rollback concurrency separately from process concurrency because rollback uses durable item state and different success/failure persistence rules.

- Test that Source Cursor Window reads remain sequential and that the next cursor is committed only after all item work in the window completes.

- Test that concurrent item failures still continue other item work, persist correct item states, and produce accurate failed counts in the final summary.

- Test that Migration Store failures still fail the definition run rather than becoming item failures.

- Test CLI parsing for run and rollback concurrency, including `"unbounded"`, and verify the status source-scan `--concurrency` / `-c` behavior remains source-scan-only.

- Prefer behavior tests around summaries, persisted item states, cursor commits, and observed maximum concurrency. Do not assert internal fiber structure.

## Out of Scope

Running multiple dependency-ordered Migration Definitions in parallel.

Durable queues, background workers, or returning `ExecutionStartResult` with a started run id.

Changing Source Plugin cursor APIs or exposing raw Source Cursor values.

Adding source read-ahead, concurrent cursor-window reads, or separate source lookup concurrency controls.

Changing Process Pipeline or Rollback Pipeline authoring APIs.

Changing destination helper retry semantics.

Changing Migration Run Summary or Rollback Run Summary shape.

Changing status Source Inventory Scan concurrency.

Automatically choosing concurrency from destination plugins or rate-limit responses.

## Further Notes

This feature is operator-facing throughput control for the current inline runtime. It should be implemented as runtime scheduling around existing per-item effects, not as a migration-author responsibility inside Process Pipelines.

The first implementation should keep the default behavior exactly equivalent to today's serial execution. Operators opt into more pressure per run, and migration authors can supply safe defaults for definitions where the destination capacity is known.
