# Add Document/JSON Total Discovery

Status: ready-for-human
Type: HITL

## Parent

[Optional Source Item Total Discovery](../PRD.md)

## What to build

Implement best-effort total discovery for document-backed and JSON source plugins. This slice needs human judgment because fetchers, parsers, and selectors can each influence the final Source Item count, and only a count of final selected Source Items is valid for progress.

Add a source-native total callback on document source options, similar in spirit to lookup. The callback should live at the document source configuration level because that is where the fetcher, parser, selector, item/subitem, version, and configured source scope come together.

When there is no safe native count path, return a typed unknown total. Do not add a generic fallback that traverses every fetcher page or every remote resource just to make a progress bar determinate.

Covers user stories 2-8, 14-19, and 23-24.

## Acceptance criteria

- [ ] Document source options expose an optional total callback that returns the shared Source Item total result.
- [ ] The total callback receives enough stable context to count final selected Source Items for the active configured source scope.
- [ ] The total callback can use source-native count paths such as API count endpoints, response metadata, manifests, indexes, or parser-level counts when they map to final selected Source Items.
- [ ] Fetcher resource counts or page counts are treated as insufficient unless the callback maps them to final selected Source Item counts.
- [ ] Item selector and subitem selector behavior are both represented in total discovery.
- [ ] Single-resource local document or JSON sources may return a known total by loading and parsing that one resource only when that is equivalent to an acceptable local read-equivalent operation.
- [ ] Paginated, remote, or multi-resource document sources without a total callback return a typed unknown total instead of doing a full traversal.
- [ ] Callback failures degrade to unknown progress with a progress warning.
- [ ] Callback failures do not fail the migration run and do not write Migration Item State or Migration Diagnostics.
- [ ] JSON source total discovery participates through its native source shape and either returns a known total for safe local cases or a typed unknown total for unsafe cases.
- [ ] Public progress output does not expose raw Source Cursor values or source-native pagination tokens.
- [ ] Tests cover callback-provided known totals, item selectors, subitem selectors, single-resource best-effort totals, paginated source unknown totals, callback failure, and normal migration execution after a discovery failure.
- [ ] Any remaining ambiguous document/JSON counting boundaries are documented in the issue or PRD before this issue is closed.

## Blocked by

[Add Source Item Total Discovery Contract](./01-add-source-item-total-discovery-contract.md)
