# Commercetools Source

Status: implemented for product, customer, and business-unit sources.

`@migrate-sdk/commercetools/source` exposes sources for reading existing
Commercetools resources into migration definitions:

- `CommercetoolsSource.products(...)`
- `CommercetoolsSource.customers(...)`
- `CommercetoolsSource.businessUnits(...)`

Each source supports cursor-window reads, direct lookup by source identity, and
an optional Source Item total count for live progress rendering.

## Discovery Policy

Commercetools sources default to full discovery. A completed run clears its
cursor, so the next run traverses the live query from the beginning. Existing
Source Item versions still prevent unchanged resources from entering the
Process Pipeline.

Opt into incremental discovery when the migration should retain a high-water
cursor between completed runs:

```ts
const source = CommercetoolsSource.products({
  discovery: "incremental",
});
```

Product, customer, and business-unit sources order cursor reads by
`lastModifiedAt` and then `id`. The persisted cursor contains both values, so a
later run discovers resources created or modified after the previous run even
when their UUID sorts before an older resource id. The resource's numeric
Commercetools `version` remains the Source Version used to decide whether the
Process Pipeline needs to run.

Incremental discovery only observes resources that appear after the high-water
cursor. Use the default full discovery when the source query or ordering cannot
guarantee that all relevant changes move past that cursor.

`migrate run --plan` and `migrate status` display the configured policy. Normal
cursor-discovery runs that select an incremental Commercetools source also print
a warning explaining that changes before the saved cursor require `--rescan`.
Targeted retries do not print the warning because they use resource identity
lookup instead of cursor discovery.

This cursor shape replaces the earlier id-only cursor. After upgrading an
existing migration definition with a saved Commercetools cursor, run it once
with `--rescan` to discard that incompatible cursor before traversing with the
new composite cursor schema:

```sh
pnpm exec migrate run products --rescan
```

A rescan starts discovery at the beginning but leaves resources with matching
Source Versions unchanged. Use `--update` instead when unchanged resources must
also run through the Process Pipeline again. On an incremental source, a rescan
establishes and retains a new high-water cursor after that traversal completes.

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
