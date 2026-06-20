# Optional Source Item Total Count

Status: ready-for-agent

## Problem Statement

Migration operators want live progress output that answers two different questions:

- Is the migration still active?
- How much of the current Migration Definition is complete?

The first question can be answered from observed runtime activity: Source Cursor Window reads, completed Source Items, outcome counters, and the active Migration Definition. The second question requires a total Source Item count, but not every source can provide that count cheaply, accurately, or safely. Some sources would need a full inventory traversal, some sources can only count after applying filters or remote pagination, and some sources should avoid count requests during normal runs because the source system is expensive or rate-limited.

The SDK needs an optional way for source plugins to expose a Source Item total when it is natural, while keeping unknown totals as a first-class progress state. Progress must never imply a percentage or remaining work estimate when the SDK only knows how many Source Items have been observed so far.

## Solution

Add an optional Source Item total count capability to configured source plugins.

Source plugins that can provide a cheap, meaningful total may expose `countTotal`. The hook returns an Effect that succeeds with either a non-negative integer count or a richer Source Item total value, such as a lower bound for capped native totals, or fails with `SourcePluginError`. Source plugins that cannot count, should not count by default, or can only count through a full Source Inventory Scan omit the capability. The runtime and CLI consume the capability opportunistically. Missing or failed total count does not fail a migration run and does not prevent live progress from rendering.

All first-party source plugins should participate in the capability in their source-native way. Participation does not mean every source always returns a known total. It means every first-party source plugin makes an intentional decision: return a known count when the source already has a safe native count path, return a lower bound when the source can only guarantee at least that many Source Items, or omit `countTotal` when counting would require an expensive or semantically unsafe inventory traversal.

Progress rendering uses three modes:

- Known total: show active Migration Definition, processed Source Items, outcome counters, and `processed / total` progress. A percentage is allowed only when the total was counted successfully and is still applicable to the current run scope.
- Lower-bound total: show active Migration Definition, processed Source Items, outcome counters, and a `minimum+` Source Item total hint without a percentage, ETA, or determinate progress bar.
- Unknown total: show active Migration Definition, processed Source Items, outcome counters, and Source Cursor Window checkpoints without a percentage, ETA, or `x / y` display.

The final Migration Run Summary remains the authoritative completion output. Source Item total count is live observability, not durable migration progress.

## User Stories

1. As a migration operator, I want live progress to show when a run is active, so that long migrations do not look stalled.

2. As a migration operator, I want known Source Item totals to be shown when they are available, so that I can estimate completion for sources that support counting.

3. As a migration operator, I want progress to remain useful when a total is unavailable, so that sources without count support still give me runtime feedback.

4. As a migration operator, I want unknown totals to avoid percentages and ETAs, so that the CLI does not imply precision it does not have.

5. As a migration operator, I want processed Source Item counts to update regardless of total availability, so that I can see actual throughput.

6. As a migration operator, I want outcome counters to update regardless of total availability, so that failures and skipped items are visible during the run.

7. As a migration operator, I want Source Cursor Window checkpoints in log progress, so that non-interactive runs show bounded activity without one line per Source Item.

8. As a migration operator, I want a source total failure to degrade to unknown progress, so that an optional observability feature does not fail business-critical migrations.

9. As a migration operator, I want source plugins to be able to disable total count, so that expensive source systems are not pressured by progress rendering.

10. As a migration operator, I want count caching to be opt-in and explicit, so that stale totals are not mistaken for current source inventory.

11. As a migration operator, I want source-scan status to remain the path for exact current inventory counts, so that a progress total does not replace full source validation.

12. As a migration operator, I want durable-only status to stay cheap, so that asking for current store state does not initialize source plugins or count source data.

13. As a migration author, I want simple source plugins to omit total count, so that authoring a source remains focused on emitting Source Items correctly.

14. As a migration author, I want first-party sources with cheap known totals to expose them, so that the CLI can show better progress without custom work.

15. As a migration author, I want every first-party source plugin to make a deliberate total-count decision, so that source support is consistent across in-memory, CSV, document, and SQL migrations.

16. As a migration author, I want totals to respect the same configured source scope as the run, so that progress does not count Source Items outside the active Migration Definition.

17. As a source plugin author, I want total count to be separate from cursor reads, so that cursor semantics stay focused on Source Cursor Window progression.

18. As a source plugin author, I want to omit total count deliberately, so that I can communicate that counting is unsupported or disabled without throwing.

19. As a source plugin author, I want total count errors to be surfaced as live progress warnings, so that operators can inspect observability problems without corrupting Migration Item State.

20. As a runtime maintainer, I want total count to avoid Migration Store writes, so that live progress remains independent from durable migration correctness.

21. As a runtime maintainer, I want total count to avoid exposing raw Source Cursor values, so that public progress output stays operator-friendly.

22. As a runtime maintainer, I want the progress reducer to model known, lower-bound, and unknown totals explicitly, so that renderers cannot accidentally calculate percentages from incomplete data.

23. As a CLI maintainer, I want interactive progress to render cleanly for known, lower-bound, and unknown totals, so that terminal output remains readable on success and failure.

24. As a CLI maintainer, I want `--progress log` to include total information only when known or lower-bound, so that CI logs stay stable and honest.

25. As an SDK caller, I want the default progress layer to remain no-op, so that direct SDK usage does not require terminal or total-count wiring.

## Implementation Decisions

- Add a Source Item total count domain type with explicit known, lower-bound, and unknown variants.

- A known total is a non-negative integer. A zero total is valid and means the configured source scope has no Source Items to process.

- A lower-bound total is a non-negative integer minimum with a reason, such as capped. It is useful for `10,000+` style progress hints, but renderers must not use it as a denominator for percentages or determinate progress bars.

- An unknown total should preserve a reason category suitable for progress warnings and status rendering, such as unsupported, disabled, too expensive, or failed.

- Total count is an optional configured source plugin capability. Existing source plugins without the capability remain valid.

- Total count must not become part of the mandatory cursor read contract. The mandatory source plugin behavior remains Source Cursor Window reads and source identity lookup.

- All existing first-party source plugins should make an explicit total-count decision. A source with a safe native count path should expose `countTotal`; a source without one should omit the capability.

- Total count must not own or mutate Migration Item State, Source Cursor progress, Migration Run State, or Migration Definition locks.

- Total count should run at Migration Definition start only when a progress consumer needs it and the source plugin declares that the operation is safe for that context.

- The runtime should treat total count failure as an unknown total unless the caller explicitly opts into strict total count in a future API.

- Progress events should include a total-count event or definition-start metadata that can carry runtime-known or runtime-unknown total state.

- `MigrationProgressState` should store total state per active Migration Definition. It should not store a single global total for `run --all`.

- Progress reducers should never derive percentage, remaining count, or completion ratio unless total state is known.

- Interactive progress should render known totals as processed count, total count, and percentage. It should render lower-bound totals as processed count plus `minimum+`. It should render unknown totals as processed count and activity indicators without percentage.

- Log progress should include total state at Migration Definition start when known or lower-bound, and otherwise use concise unknown-total wording.

- Source Cursor Window checkpoint output should remain useful in unknown-total mode by showing completed windows and processed Source Items.

- Run limits should cap the displayed total when the counted total is greater than the limit. If a lower-bound total is greater than or equal to the item limit, the effective run total becomes known because the source has enough items to satisfy the limited run scope.

- Source Inventory Scan remains the exact inventory-count path. A counted total may be useful for progress, but it is not a substitute for scan-source validation, duplicate detection, invalid payload counts, or orphaned durable state analysis.

- Durable-only status must not call total count. It should continue to render source inventory fields as unavailable unless source scanning is explicitly requested.

- Source-scan status may continue computing total Source Items from the scan itself. It does not need to call the optional total count capability.

- In-memory source total count should return the configured item count directly from `items.length`. `batchSize` affects Source Cursor Window size, not the total.

- CSV source total count should use the CSV source's native file-loading and parsing path, then return the number of parsed Source Items selected from the current file. It should count the same rows the CSV source would emit for the current configuration, including dialect, header, empty-row, identity, and version options.

- CSV total count failures should degrade progress to an unknown total. The later migration read still decides run correctness; total count must not persist a failed Migration Item State or source diagnostic.

- Document source total count should be conservative because fetchers, parsers, and selectors can each influence the final Source Item count. A fetcher may know resource or page counts, a parser may know item counts inside one resource, and a selector may turn one parsed document into zero, one, or many Source Items. Only a count of final selected Source Items is valid for progress.

- Document source options should grow an optional total callback, similar in spirit to `lookup`. The callback belongs on the document source configuration rather than the low-level fetcher because only the document source has the fetcher, parser, selector, item/subitem, and version context needed to define what "total Source Items" means.

- The document source total callback should be source-native and may use an API count endpoint, response metadata, an index, a manifest, a parser-level count available from a single resource, or another source-specific counting path. It should return the final selected Source Item count as a non-negative integer or Source Item total value.

- The document source total callback should not be a generic fallback that repeatedly calls the configured fetcher and parser until the source is exhausted. If the only way to know the total is to scan every resource or page, the source should omit `countTotal` and operators should use Source Inventory Scan when they need exact inventory counts.

- The document source total callback should receive enough stable context to count the same configured selection that reads would emit, but it must not expose raw Source Cursor values in public progress output.

- When a document source total callback is not provided, single-resource document sources may return a known total by loading and parsing the single resource only when that work is an acceptable local read-equivalent operation. Multi-page or remote document sources without a callback should omit `countTotal` instead of doing a full traversal only for progress.

- SQL source total count should be an explicit author-provided count statement or count effect on the SQL source options. The SDK must not attempt to derive a count by rewriting arbitrary read SQL, removing `limit`, or interpreting cursor predicates.

- SQL total count should use the same `SqlClient` requirement as SQL reads, but it should be a separate operation from `read` and `readByIdentity`. Count statement failures degrade progress to unknown unless a future strict-count mode is explicitly introduced.

- Source plugins that need a native count hook should expose the hook at the plugin-native level, then normalize the returned count at the configured source boundary.

- Optional count caching belongs to source plugin configuration, not the core Migration Store. Caching must be explicit because stale totals affect operator expectations.

- CLI output should not use raw Source Cursor values, source-native pagination tokens, or internal cursor encodings to explain total state.

- The final Migration Run Summary remains unchanged and authoritative. Live progress is transient observability.

## Testing Decisions

- Test the total count domain type with known zero, known positive, lower-bound, and unknown variants.

- Test that configured source plugins without total count continue to run normally.

- Test a source plugin that returns a known total and verify progress state stores it for the active Migration Definition.

- Test a source plugin that returns a lower-bound total and verify progress state stores it for the active Migration Definition.

- Test a source plugin that omits total count and verify progress state records an unsupported unknown total.

- Test that every existing first-party source plugin either implements the optional total count capability or intentionally omits it.

- Test in-memory source total count returns `items.length` and does not call `read` or `readByIdentity`.

- Test CSV source total count counts parsed Source Items for the configured dialect, headers, empty-row policy, identity, version, and source schema.

- Test CSV source total count failure degrades progress to unknown without creating Migration Item State or Migration Diagnostics.

- Test document source total count returns a known total for a single-resource file-backed document source by using the same parser and selector behavior as reads.

- Test document source total count is omitted for paginated document fetchers that do not provide a document total callback.

- Test document source total count uses the document source total callback when available and does not traverse every fetcher page solely for progress.

- Test document source total count callback behavior for both item selectors and subitem selectors so totals match the configured Source Item selection.

- Test document source total count treats fetcher resource counts as insufficient unless the callback maps them to final selected Source Item counts.

- Test SQL source total count uses an explicit count statement or count effect and does not call the configured `read` or `readByIdentity` statement builders.

- Test SQL source total count failure degrades progress to unknown and preserves normal migration execution.

- Test total count failure and verify the migration run continues with unknown-total progress.

- Test that total count does not read or write persisted Source Cursor progress.

- Test that total count does not write Migration Item State, Migration Run State, or Migration Diagnostics.

- Test that `run --all` keeps total state scoped to one active Migration Definition at a time.

- Test that run limits cap the displayed total for progress rendering, including lower-bound totals that satisfy the item limit.

- Test that the progress reducer never emits percentage or remaining-work values for lower-bound or unknown totals.

- Test interactive progress rendering for known totals, lower-bound totals, unknown totals, zero totals, success cleanup, and failure cleanup.

- Test `--progress log` rendering for known, lower-bound, and unknown totals.

- Test that non-TTY default output remains stable.

- Test that `--progress none` avoids total count unless another explicit consumer requests it.

- Test durable-only status does not initialize source plugins for total count.

- Test source-scan status continues to compute inventory totals by scanning and does not require optional total count.

- Use existing progress reducer and CLI progress tests as prior art. Keep tests focused on public behavior and progress state, not private render-loop details.

## Out of Scope

Forcing every source plugin to support total count.

Requiring every first-party source plugin to always return a known total.

Using a generic full Source Cursor traversal as the fallback implementation for progress totals.

Inferring SQL counts by rewriting migration-author SQL.

Failing migration runs when optional total count is missing or fails.

Replacing Source Inventory Scan with total count.

Persisting counted totals in the Migration Store.

Adding durable progress snapshots or progress replay.

Adding ETA calculations.

Adding source scan progress streaming.

Adding per-source custom progress renderers.

Adding a third-party progress bar dependency.

Changing the final Migration Run Summary contract.

Changing source cursor semantics or exposing raw Source Cursor values.

## Further Notes

This PRD exists to make known totals better without making unknown totals worse.

The important product behavior is honesty: show percentages only when the SDK has a real total for the active run scope; otherwise show activity, processed count, outcome counters, and checkpoints.
