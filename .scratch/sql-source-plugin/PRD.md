# SQL Source Plugin

Status: ready-for-agent

## Problem Statement

Migration authors need a first-party SQL source plugin for reading Source Items
from SQL databases without inventing a migrate-sdk-specific database driver
abstraction. The SDK already has a durable source contract, cursor windows,
Source Payload Schema validation, direct identity lookup, and source retry
hooks, but the SQL source is currently only scaffolded and intentionally
unimplemented.

Raw SQL sources should let authors write the SQL they need while preserving the
framework's Source Item semantics. They should be resumable, bounded by cursor
windows, identity-addressable for reruns, schema-backed at the source payload
boundary, and explicit about where SQL-specific behavior ends and the
Transformation Pipeline begins.

## Solution

Implement `SqlSourcePlugin` as a first-party source plugin in the main SDK
package. The plugin uses Effect SQL `SqlClient` through an exposed Effect layer
requirement, not concrete database clients and not an SDK-owned driver.

The raw SQL source API accepts statement-builder callbacks for cursor reads and
identity lookup. `SqlSourcePlugin` executes those statements, enforces direct
lookup semantics, extracts Source Identity, Source Version, and Source Cursor
metadata from read-only SQL rows, and returns Source Items to the existing
runtime. The SQL row itself is the source-native payload; the runner decodes it
through the configured Source Payload Schema before invoking the Transformation
Pipeline.

By default, the configured SQL source exposes `SqlClient.SqlClient` as an Effect
layer requirement. Migration authors can either leave that requirement visible
and provide one shared app layer at the runner/registry boundary, or call
`source.provide(sqlClientLayer)` so a specific source instance owns its SQL
client layer and no SQL requirement leaks into the migration definition.

The first implementation keeps raw SQL untyped from SQL text. TypeScript row
typing should come from the encoded/input side of `sourceSchema`, once the core
source schema contract preserves that side. Any Effect SQL schema-backed row
decoding is internal or helper-owned and must not introduce a second required
user-facing schema.

## User Stories

1. As a migration author, I want to configure a SQL source from raw SQL
   statement builders, so that I can migrate from legacy databases without
   writing a custom source plugin.

2. As a migration author, I want the SQL source to use Effect SQL `SqlClient`,
   so that database drivers, pooling, parameter binding, and dialect behavior
   come from Effect SQL rather than migrate-sdk.

3. As a migration author, I want SQL source plugins to require
   `SqlClient.SqlClient` until I provide them, so that my app can either share
   one database layer at the runner boundary or close a specific source over
   its own database layer.

4. As a migration author, I want SQL source configuration to require
   `sourceSchema`, so that the runner validates source payloads before my
   pipeline receives them.

5. As a migration author, I want the SQL row type to come from the input side of
   `sourceSchema`, so that metadata extraction and payload decoding are backed
   by one schema contract instead of duplicated row types.

6. As a migration author, I want SQL rows to be treated as the source-native
   payload, so that SQL projection and Source Payload Schema control the
   pipeline-facing shape.

7. As a migration author, I want metadata extraction to produce Source Identity,
   Source Version, and Source Cursor only, so that SQL source configuration does
   not become a transformation pipeline.

8. As a migration author, I want metadata extraction to return a Result-style
   success or error value, so that expected metadata failures do not rely on
   thrown exceptions.

9. As a migration author, I want SQL rows to be read-only in metadata
   extraction, so that source extraction cannot mutate the payload that the
   runner will validate.

10. As a migration author, I want `batchSize` to be the public source option for
    cursor window size, so that the migration concept is named consistently
    even though SQL applies it as `LIMIT`.

11. As a migration author, I want the read statement builder to receive `limit`,
    so that my SQL can apply the configured `batchSize` without the SDK trying
    to rewrite arbitrary SQL.

12. As a migration author, I want keyset pagination examples, so that I can
    write deterministic cursor reads instead of offset-based queries.

13. As a migration author, I want the Source Cursor to be derived from each
    returned row, so that the plugin can resume after the last emitted row.

14. As a migration author, I want `nextCursor` to come from the last row in a
    non-empty read window, so that cursor advancement is deterministic.

15. As a migration author, I want empty read windows to terminate cursor
    discovery, so that final pages do not require special markers.

16. As a migration author, I want the plugin not to issue `limit + 1` probes, so
    that statement execution remains exactly the SQL I configured.

17. As a migration author, I want no first-class `offset` option, so that durable
    source progress is carried by Source Cursor rather than hidden SQL offsets.

18. As a migration author, I want direct lookup to be required, so that failed
    reruns, skipped reruns, needs-update backlog, update checks, and single-item
    runs can retrieve the same Source Item by Source Identity.

19. As a migration author, I want lookup statement builders to return SQL
    statements rather than perform effects, so that execution policy and error
    normalization stay inside the source plugin.

20. As a migration author, I want lookup SQL to be identity-unique, so that one
    Source Identity cannot ambiguously resolve to multiple rows.

21. As a migration author, I want lookup results to use the same metadata
    extractor as cursor reads, so that both access paths produce the same Source
    Item semantics.

22. As a migration author, I want lookup to ignore the extracted cursor
    operationally, so that identity lookup does not advance source position.

23. As a migration author, I want lookup to verify that the returned row's
    extracted Source Identity matches the requested identity, so that a bad
    lookup statement cannot process the wrong Source Item.

24. As a migration author, I want duplicate Source Identities within one read
    window to fail the cursor read, so that bad joins or projections do not
    process the same Source Item twice in one window.

25. As a migration author, I want Source Version and Source Cursor to remain
    separate concepts, so that change detection and cursor resume can use
    different signals when needed.

26. As a migration operator, I want invalid source payloads from SQL rows to
    become item failures when identity and version are valid, so that one bad
    row does not stop unrelated rows.

27. As a migration operator, I want SQL execution and metadata failures during
    cursor discovery to fail the cursor read, so that the runner does not record
    item state without a trustworthy Source Identity.

28. As a migration operator, I want metadata failures during identity lookup to
    become lookup failures for the requested identity, so that item-specific
    rerun behavior remains consistent.

29. As a migration operator, I want SQL reads and lookups not to be wrapped in
    transactions by default, so that source reads do not hold unnecessary
    database transactions or snapshots.

30. As an SDK maintainer, I want SQL source internals to stay under the SQL
    source folder until a SQL destination or shared module proves reuse, so that
    the implementation stays focused.

31. As an SDK maintainer, I want raw SQL source query callbacks to be statement
    builders, so that `SqlSourcePlugin` owns execution, cardinality checks,
    error normalization, metadata extraction, and cursor advancement.

32. As an SDK maintainer, I want SQL source errors to normalize to the current
    source boundary for v1, so that the existing runtime, CLI rendering, and
    durable item error model keep working.

33. As an SDK maintainer, I want the source authoring docs to record the future
    typed-error-channel question, so that retry classification can be revisited
    without blocking SQL v1.

34. As an SDK maintainer, I want the source schema contract to preserve the
    encoded/input side in the future, so that schema-backed source plugins can
    type source-native metadata extraction from the same schema the runner uses
    for payload decoding.

35. As a future Drizzle source author, I want raw SQL and Drizzle-backed SQL to
    remain separate source plugins, so that Drizzle typing does not complicate
    the raw SQL source contract.

## Implementation Decisions

- Keep `SqlSourcePlugin` as a first-party source plugin in the main SDK package,
  not a separate package.

- Keep SQL source-specific internals local to the SQL source area until a real
  SQL destination or shared SQL module proves the need for broader reuse.

- Use Effect SQL `SqlClient` as the database boundary.

- Expose `SqlClient.SqlClient` as the configured SQL source layer requirement.
  Do not use an ambient or global SQL client, and do not hide a concrete
  database layer inside source options.

- Support `ConfiguredSourcePlugin.provide(layer)` as the source-local provision
  boundary. Providing a SQL client layer on the configured source erases
  `SqlClient.SqlClient` from that source's requirements; leaving it unprovided
  preserves the requirement for app-level provision.

- Do not accept concrete database clients such as Postgres or MySQL clients
  directly in the raw SQL source API.

- Keep raw SQL query text untyped from SQL text. Do not infer row types from SQL
  templates.

- Require exactly one public Source Payload Schema, `sourceSchema`.

- Do not require a second public SQL row schema.

- Allow internal or helper-owned Effect SQL row decoding, but keep the
  configured Source Payload Schema as the framework boundary.

- Preserve the encoded/source-native side of `sourceSchema` as the target row
  type for SQL metadata extraction. The current core source schema type erases
  that side as `unknown`, so this requires a source contract refinement.

- Use the SQL row returned by the statement as the Source Item payload.

- Do not expose a separate payload mapper in raw SQL v1.

- Keep Source Payload Schema decoding in the migration runner, not inside the
  SQL source plugin.

- Keep metadata extraction focused on Source Identity input, Source Version
  input, and Source Cursor only.

- Require metadata extraction to return a Result-style success or error value.
  The exact Result implementation can be selected during the implementation
  slice.

- Treat SQL rows as read-only metadata extraction inputs.

- Provide metadata extraction context with page-local `rowIndex` for diagnostics
  only.

- Do not include operation kind, Effect services, or input cursor in the
  metadata extraction context.

- Use one metadata extractor for both cursor read rows and lookup rows.

- Require cursor metadata for every returned row.

- Compute `nextCursor` from the last emitted row's cursor.

- Return no `nextCursor` for empty read windows.

- Do not use `limit + 1` probing in raw SQL v1.

- Require `batchSize` and validate it as a positive integer.

- Pass `batchSize` into the read statement builder as `limit`.

- Do not expose `offset` as a first-class source option.

- Document keyset pagination as the expected SQL cursor strategy.

- Require read statements to apply deterministic ordering compatible with the
  cursor returned from metadata extraction.

- Recommend stable tie-breakers in read ordering, usually including Source
  Identity.

- Require a direct lookup statement builder.

- Set SQL source lookup strategy to direct internally.

- Do not expose scan lookup in raw SQL v1.

- Trust the lookup statement contract that one Source Identity identifies at
  most one Source Item, but fail when the executed lookup actually returns more
  than one row.

- Do not show `LIMIT 1` in lookup examples; use `where id = ...` so duplicate
  lookup rows remain detectable.

- Verify that lookup metadata identity normalizes to the requested Source
  Identity.

- Ignore lookup cursor operationally because identity lookup does not advance
  source position.

- Reject duplicate Source Identities inside one cursor window after normal
  Source Identity input normalization.

- Do not attempt duplicate detection across cursor windows.

- Treat metadata extraction failure during cursor reads as a cursor-read source
  failure.

- Treat metadata extraction failure during identity lookup as a lookup source
  failure for the requested Source Identity.

- Keep invalid source payloads as item-level failures when identity and version
  are valid.

- Do not wrap SQL reads or lookups in SQL transactions by default.

- Leave transaction or consistent-snapshot behavior for a future explicit source
  option.

- Keep SQL source v1 on the current `SourcePluginError` runtime contract.

- Document the future architecture question of plugin-specific typed error
  channels before source error normalization.

- Keep Drizzle-backed SQL as a separate future source plugin.

## Testing Decisions

- Test public source behavior through configured source plugin reads and lookup
  calls rather than private helper details.

- Add focused unit tests for the SQL source deep module that turns SQL rows into
  Source Item inputs and cursor windows.

- Use a scripted or fake `SqlClient` layer for deterministic source tests rather
  than depending on a real database in the first implementation slice.

- Test that `SqlClient.SqlClient` is required by the API shape and that the
  source uses the provided layer for read and lookup execution.

- Test that `source.provide(sqlClientLayer)` erases the SQL client requirement
  from the configured source and from migrations using that source.

- Test that two configured SQL source instances can be provided with different
  SQL client layers even though both layers provide the same Effect service
  tag.

- Test that `batchSize` must be a positive integer.

- Test that read statement builders receive `cursor`, `limit`, and `sql`.

- Test that lookup statement builders receive `identity` and `sql`.

- Test that read and lookup callbacks are executed by the plugin, not by the
  caller.

- Test that a non-empty read result returns Source Items and `nextCursor` from
  the last row.

- Test that an empty read result returns no items and no `nextCursor`.

- Test that the plugin does not do `limit + 1` row handling.

- Test that source metadata extraction receives read-only row values and
  page-local row indexes.

- Test that metadata extraction Result errors during read fail the cursor read.

- Test that metadata extraction Result errors during lookup fail the lookup.

- Test that missing or invalid cursor metadata fails a non-empty read window.

- Test that lookup returning no rows returns `null`.

- Test that lookup returning multiple rows fails.

- Test that lookup returning a row whose extracted Source Identity does not
  match the requested identity fails.

- Test that duplicate Source Identities within one read window fail the read.

- Test that lookup ignores extracted cursor in its return value.

- Test that the source item payload passed to the runtime is the SQL row, with
  no payload mapper involved.

- Test integration with the main migration runner so SQL source rows are decoded
  by Source Payload Schema before pipeline execution.

- Test that invalid SQL source payloads with valid identity and version become
  failed Migration Item State records, matching the existing source boundary
  behavior.

- Test that SQL execution failures normalize through the current source error
  boundary.

- Reuse existing source plugin definition tests for normalization of Source
  Identity, Source Version, Source Cursor Schema, and Source Payload Schema
  behavior.

- Reuse runtime tests for cursor advancement, item failure behavior, and
  `readByIdentity` rerun semantics.

- Keep transaction behavior out of v1 tests except verifying that no automatic
  transaction wrapper is required for ordinary read and lookup paths.

## Out of Scope

- Implementing a SQL destination plugin.

- Moving SQL internals into a shared SQL module before a destination use case
  exists.

- Inferring TypeScript row types from raw SQL text.

- Inferring Source Payload Schema from database table metadata.

- Requiring or exposing a second SQL row schema.

- Implementing a Drizzle-backed source plugin.

- Supporting scan lookup for SQL source reruns.

- Supporting offset pagination as a first-class API concept.

- Rewriting arbitrary SQL to inject `LIMIT`, `OFFSET`, uniqueness checks, or
  ordering.

- Automatically wrapping reads or lookups in SQL transactions.

- Designing consistent snapshot behavior.

- Changing CLI behavior for source diagnostics.

- Completing the broader typed source error channel redesign.

- Completing the broader source schema input-type preservation refactor beyond
  what is needed for SQL source ergonomics.

- Adding implementation issues in this PRD slice.

## Further Notes

- ADR-0005 records the decision to use Effect SQL `SqlClient` instead of an
  SDK-owned SQL driver abstraction.

- The SQL source design document is the canonical detailed API sketch for this
  PRD.

- The current scaffold already creates the SQL source folder, public exports,
  and intentionally unimplemented plugin surface.

- The main deep module opportunity is row-to-source-window materialization: it
  should encapsulate row execution results, metadata Result handling, identity
  normalization, duplicate detection, cursor derivation, lookup cardinality, and
  lookup identity consistency behind a small testable interface.

- A second deep module opportunity is source schema typing: preserving the
  encoded/source-native side of Source Payload Schema should improve SQL and
  future schema-backed source plugins without changing runner behavior.

- A future typed source error channel should let plugin-specific retry policies
  observe native transport, timeout, SQL, and metadata errors before the runtime
  normalizes them for framework reporting.
