# Commercetools Source

Status: implemented for product, customer, and business-unit sources.

`@migrate-sdk/commercetools/source` exposes sources for reading existing
Commercetools resources into migration definitions:

- `CommercetoolsSource.products(...)`
- `CommercetoolsSource.customers(...)`
- `CommercetoolsSource.businessUnits(...)`

Each source supports cursor-window reads, direct lookup by source identity, and
an optional Source Item total count for live progress rendering.

## Source Item Totals

Product, customer, and business-unit sources expose `countTotal`. The count
uses the same source scope as reads for `where` and `whereVariables`, but it
stays separate from cursor-window reads and lookup. Count requests use
`limit: 0` with `withTotal: true`; they do not run projections, derive source
identity, read cursor windows, or write migration state.

Commercetools totals are live progress observability. They are useful at
migration start, but they are not authoritative inventory validation. Source
Inventory Scan and the final Migration Run Summary remain the source of truth
for migrated, skipped, unchanged, and failed item counts.

When a filtered query returns the Commercetools query total cap, `countTotal`
returns a lower-bound total. Progress renderers can show that as `10,000+`
Source Items without treating it as a percentage denominator.

If Commercetools omits a usable non-negative `total`, or the count request
fails, the source `countTotal` fails with `SourceError`. Runtime progress
then reports an unknown total and continues the migration run normally.
