# Add Commercetools Source Total Count

Status: ready-for-human
Type: AFK

## Parent

[Optional Source Item Total Count](../PRD.md)

## What to build

Add Commercetools-native Source Item total count for the Commercetools source plugin. Products, customers, and business units should expose `countTotal` by issuing a source-native count request that matches the configured source scope, then return the non-negative Source Item count or a lower-bound total when Commercetools caps a filtered count.

Total count must stay separate from migration reads and source identity lookup. The existing cursor-window read path should remain optimized for large migrations, while total count performs only the count request needed for live progress. If Commercetools cannot return a usable total for the configured scope, `countTotal` should fail with `SourcePluginError` so runtime progress degrades to an unknown total and the migration run continues normally. If Commercetools returns the filtered query cap, the source should return a lower-bound total so operators still see `10,000+` instead of losing the useful signal.

Because Commercetools query totals are progress observability rather than inventory validation, document the package-level caveat that these totals are a live progress hint and not a substitute for Source Inventory Scan or final Migration Run Summary counts.

Covers user stories 2-8, 14-19, and 23-24.

## Acceptance criteria

- [x] Commercetools product, customer, and business-unit sources expose `countTotal`.
- [x] Total count uses a Commercetools-native count query that applies the same configured source scope as reads, including `where` and `whereVariables`.
- [x] Total count does not call cursor-window `read`, `readByIdentity`, projection selectors, or source identity extraction.
- [x] Total count does not include cursor predicates, raw Source Cursor values, source-native pagination tokens, or cursor variables in the count request.
- [x] The existing cursor-window read path continues to use no-total, id-sorted pagination for migration correctness and throughput.
- [x] A usable Commercetools count maps to a known non-negative Source Item total, including zero.
- [x] Capped filtered count responses return a lower-bound total rather than a misleading known total.
- [x] Missing, unsupported, invalid, or semantically unsafe count responses fail `countTotal` rather than returning a misleading known total.
- [x] Count request failures degrade to an unknown failed progress total and progress warning without failing the migration run.
- [x] Total count does not write Migration Item State, Migration Run State, Migration Diagnostics, persisted Source Cursor progress, or Migration Definition locks.
- [x] Commercetools package docs or examples describe the total as live progress observability, not authoritative inventory validation.
- [x] Tests cover known totals for products, customers, and business units.
- [x] Tests cover source-scope-sensitive counts with `where` and `whereVariables`.
- [x] Tests cover zero totals, capped filtered totals, count failure degradation, no read/lookup/projection calls, and preservation of normal migration execution after count failure.
- [x] Tests assert the count request shape does not expose cursor state and the read request shape remains unchanged.

## Blocked by

[Add Source Item Total Count Contract](./01-add-source-item-total-discovery-contract.md)
