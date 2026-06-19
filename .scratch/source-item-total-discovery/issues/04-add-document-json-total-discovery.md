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

- [x] Document source options expose an optional total callback that returns the shared Source Item total result.
- [x] The total callback receives enough stable context to count final selected Source Items for the active configured source scope.
- [x] The total callback can use source-native count paths such as API count endpoints, response metadata, manifests, indexes, or parser-level counts when they map to final selected Source Items.
- [x] Fetcher resource counts or page counts are treated as insufficient unless the callback maps them to final selected Source Item counts.
- [x] Item selector and subitem selector behavior are both represented in total discovery.
- [x] Single-resource local document or JSON sources may return a known total by loading and parsing that one resource only when that is equivalent to an acceptable local read-equivalent operation.
- [x] Paginated, remote, or multi-resource document sources without a total callback return a typed unknown total instead of doing a full traversal.
- [x] Callback failures degrade to unknown progress with a progress warning.
- [x] Callback failures do not fail the migration run and do not write Migration Item State or Migration Diagnostics.
- [x] JSON source total discovery participates through its native source shape and either returns a known total for safe local cases or a typed unknown total for unsafe cases.
- [x] Public progress output does not expose raw Source Cursor values or source-native pagination tokens.
- [x] Tests cover callback-provided known totals, item selectors, subitem selectors, single-resource best-effort totals, paginated source unknown totals, callback failure, and normal migration execution after a discovery failure.
- [x] Any remaining ambiguous document/JSON counting boundaries are documented in the issue or PRD before this issue is closed.

## Blocked by

[Add Source Item Total Discovery Contract](./01-add-source-item-total-discovery-contract.md)

## Completion note

Implemented best-effort document/JSON total discovery with a source-level `discoverSourceItemTotal` callback. The callback receives helper functions that count final selected Source Items from parsed documents or a resource result using the configured parser and selector, so API count endpoints, manifests, response metadata, or parser-level counts can be mapped deliberately to final source scope.

Built-in automatic totals are intentionally limited to `DocumentFetchers.fileText`, where loading and parsing one local resource is the same read-equivalent operation the source already performs. Paginated, remote, custom, and multi-resource document sources without the callback return unknown `too-expensive` totals and do not read or traverse the source for progress.
