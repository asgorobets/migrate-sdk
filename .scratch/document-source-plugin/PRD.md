# Document Source Plugin

Status: ready-for-agent

## Problem Statement

The SDK has source implementations that solve the same problem in different
ways. Local JSON source behavior reads a structured file, validates a document,
selects nested items, preserves optional parent context, and builds durable
source items. The API source example fetches structured data through Effect
services, decodes payloads, manages source identity and version, and implements
the durable source plugin contract manually.

If every transport and format combination becomes its own source plugin, the
SDK will accumulate duplicated behavior for parsing, schema-backed selection,
identity derivation, version derivation, duplicate identity checks, direct
lookup, and cursor-window adaptation. Migration authors will also get different
authoring models for JSON file, JSON API, XML file, XML API, and similar
sources even when they are all selecting items from structured documents.

The SDK needs one Effect-native document source architecture that composes
fetching, parsing, schema-backed item selection, identity, lookup, and version
without weakening the existing durable Source Plugin runtime contract.

## Solution

Introduce a Document Source Plugin architecture.

A Document Source Plugin fetches one structured resource or page at a time,
parses it into schema-backed documents, selects source item payloads from those
documents, derives durable source identity and version, and adapts the result to
the existing Source Plugin cursor-window runtime.

The authoring model is:

- `fetcher`: retrieves resources for a parser.
- `parser`: validates and decodes resources into document values.
- `selector`: selects source item payloads, and optional parent context, from
  decoded documents.
- `identity`: derives durable source identity from the selected payload.
- `lookup`: declares scan or direct identity lookup behavior.
- `version`: derives source version from the selected payload.

The first implementation slice should build the reusable core and prove it with
local file + JSON behavior. It should also include the Effect-native fetcher
escape hatch so API-backed sources are not forced through a narrow HTTP helper.

## User Stories

1. As a migration author, I want to select source items from a structured JSON
   document, so that I can migrate nested source data without writing a custom
   source plugin.

2. As a migration author, I want to use the same document schema for multiple
   migrations, so that business units, contacts, and addresses can come from the
   same source document while each migration processes its own slice.

3. As a migration author, I want nested selectors to preserve parent context, so
   that a contact migration can access both the contact and its parent business
   unit.

4. As a migration author, I want destination projection to stay in the pipeline,
   so that source configuration only selects source items and does not become a
   field-mapping DSL.

5. As a migration author, I want selector callbacks to be fully TypeScript
   inferred from the document schema, so that authoring source slices is guided
   by typed property access.

6. As a migration author, I want source item payloads to be schema-backed, so
   that the pipeline receives validated data rather than untrusted JSON values.

7. As a migration author, I want source identity derivation to be explicit, so
   that durable migration state is tied to stable source identities.

8. As a migration author, I want source version derivation to be explicit, so
   that unchanged detection is based on a stable source revision.

9. As a migration author, I want a content-hash version option, so that simple
   document slices can derive source versions without custom version code.

10. As a migration author, I want content hashes to use schema-encoded selected
    items, so that hashing is stable and follows schema encoding semantics.

11. As a migration author, I want scan lookup to be explicit, so that expensive
    identity lookup behavior is visible in source configuration.

12. As a migration author, I want direct lookup to be configurable, so that a
    source can fetch one resource by source identity when the source system
    supports it.

13. As a migration author, I want direct lookup to still parse, select, and
    verify identities, so that direct lookup cannot bypass source correctness
    checks.

14. As a migration author, I want duplicate selected source identities to fail,
    so that reruns never depend on incidental source ordering.

15. As a source author, I want a reusable document source core, so that local
    files and remote APIs share parser, selector, identity, version, and lookup
    behavior.

16. As a source author, I want a file text fetcher helper, so that local JSON
    resources use Effect platform services instead of direct Node filesystem
    APIs.

17. As a source author, I want an Effect-native fetcher helper, so that API
    sources can use services, layers, retries, concurrency, and multi-call
    resource assembly without a narrow HTTP abstraction.

18. As a source author, I want parsers to be separate from fetchers, so that
    fetching and schema-backed decoding can evolve independently.

19. As a source author, I want a JSON parser helper, so that string resources
    can be parsed and schema-decoded through Effect Schema.

20. As a source author, I want a schema parser helper for already-materialized
    values, so that Effect-native API clients do not have to convert values back
    to JSON text before validation.

21. As a source author, I want parser diagnostics to include a required parser
    name, so that parse and schema failures explain which parser failed.

22. As a source author, I want parser errors to stay parser-local, so that the
    same parser can be reused with file, API, and future fetchers.

23. As a source author, I want the document source to annotate parser failures
    with resource context, so that operators can see file path, URL, cursor, or
    fingerprint context when available.

24. As a source author, I want parser output to be a readonly document
    collection, so that one fetched resource can yield zero, one, or many parsed
    documents.

25. As a source author, I want JSON parser success to return exactly one
    document, so that JSON root arrays are not confused with multiple resource
    documents.

26. As a source author, I want fetcher cursors, parsed document index, selected
    item index, and optional resource fingerprint to combine into one durable
    source cursor, so that cursor progress is stable across multi-page and
    multi-document resources.

27. As a source author, I want resource fingerprints to detect changed
    partially consumed resources, so that a source can safely restart resource
    processing when the same fetcher cursor returns different content.

28. As a source author, I want fetchers to own IO and transport metadata checks,
    so that parsers do not become HTTP or filesystem aware by default.

29. As a source author, I want custom fetchers and custom parsers to be first
    class, so that unusual transports and formats do not require framework
    changes.

30. As a framework maintainer, I want the existing Source Plugin runtime
    contract to remain unchanged, so that document sources can plug into current
    migration execution, retry, state, and lookup behavior.

31. As a framework maintainer, I want CSV to stay separate, so that row-oriented
    CSV dialect and table concerns do not get forced into the document source
    model.

32. As a framework maintainer, I want parser-specific result shapes hidden from
    migration authors, so that parser internals do not leak into the public
    migration API.

33. As a framework maintainer, I want implementation modules to be deep and
    testable, so that fetcher, parser, selector, cursor, and source-item
    assembly behavior can be verified without fragile end-to-end-only tests.

## Implementation Decisions

- Build a `DocumentSourcePlugin` composer that produces the existing configured
  Source Plugin runtime shape.

- Introduce `DocumentFetcher` as the component that retrieves a resource for a
  parser.

- Introduce `DocumentFetchResult` with `resource`, optional `fingerprint`, and
  optional `nextCursor`.

- Introduce `DocumentParser` with required diagnostic `name`, `documentSchema`,
  and `parse(resource)` returning a readonly document collection.

- Keep parser labels diagnostic only. Do not use parser names for routing or
  behavior.

- Add `DocumentParsers.json(schema)` for string resources that should be parsed
  and decoded through Effect Schema JSON decoding.

- Add `DocumentParsers.schema(name, schema)` for already-materialized resource
  values that still need schema-backed document validation.

- Add `DocumentFetchers.fileText(...)` as the first concrete fetcher helper for
  local text resources.

- Add `DocumentFetchers.effect(...)` as the low-level Effect-native fetcher
  helper for API-backed and custom source resource assembly.

- Defer any `httpText` convenience helper until a real HTTP source use case
  proves the API shape. The power API is the effect-native fetcher.

- Keep fetcher and parser dependencies controlled at source construction time.
  The migration runner executes the configured source layer and does not
  implicitly provide parser-specific services.

- Allow first-party fetcher helpers to expose platform or client layers because
  they perform IO.

- Do not require first-party pure parser helpers to expose platform layers.
  Dependency-heavy parsers can be custom parsers or parser factories.

- Keep transport metadata checks, byte decoding, content type checks, and HTTP
  status checks in fetchers or resource decoders, not JSON parser helpers.

- Make `selector` the top-level source configuration key rather than `items`.

- Support top-level selectors that produce selected payloads shaped as `{ item
  }`.

- Support nested selectors with `parent` and `item` callbacks that produce
  selected payloads shaped as `{ parent, item }`.

- Preserve parent context only for hierarchical selectors. Do not add jq-style
  joins, lookups, JSONPath, or root-object field picking.

- Keep destination projection in the transformation pipeline.

- Infer selector callback types from the parser document schema.

- Use internal schema cursor helper types if needed to preserve field-level
  inference at authoring time, while keeping the public call site as normal
  property access.

- Derive the configured source payload schema from the selected item shape.

- Build source identities from explicit `identity` configuration.

- Build source versions from explicit `version` configuration.

- Implement content-hash source versions over schema-encoded selected source
  payloads, not ad hoc JSON stringification of raw JavaScript objects.

- Require explicit `lookup` configuration on the low-level document source
  composer.

- Compile `lookup` into the existing runtime Source Lookup Strategy. Do not add
  a second lookup-kind system for fetchers.

- Support scan lookup by reading resources, parsing documents, applying the
  selector, deriving identities, and matching the requested source identity.

- Support direct lookup by calling a configured resource read, then still
  parsing, selecting, deriving identity, and verifying the requested identity.

- Treat direct lookup not-found as `null` at the document source boundary to
  match the existing source plugin lookup contract.

- Treat direct lookup failures such as credentials, transport, permission, and
  invalid response as source plugin failures.

- Fail duplicate selected source identities in both scan and direct lookup.

- Normalize parser output to a readonly document collection and let the document
  source own document index progress.

- Allow generic parser output to contain zero documents. Treat zero documents as
  an exhausted resource and advance to the next fetcher cursor.

- Make JSON parser success return exactly one parsed document.

- Keep streaming parser contracts out of the first slice.

- Introduce one document source cursor envelope that combines fetcher cursor,
  parsed document index, selected item index, and optional resource fingerprint.

- Keep source items free of discovery cursor metadata. Source items keep
  identity, version, and payload; cursor records discovery progress.

- On a partially consumed resource, carry the resource fingerprint in the next
  source cursor.

- If the same fetcher cursor later returns a different resource fingerprint,
  restart that resource at document index zero and item index zero.

- Preserve the existing migration pipeline shape. The pipeline still receives
  the normal runtime source item envelope, whose payload is the selected
  document payload.

- Do not export document-source-specific internals from the root public SDK
  entrypoint unless they are intended as stable public API.

- Keep examples outside the root public API surface and focused on migration
  author usage.

## Testing Decisions

- Use TDD for the implementation.

- Start tests at the contract level for parsers and fetchers before composing
  the full source plugin.

- Test parser helpers as external behavior: successful decoding, schema
  failures, parser names in diagnostics, zero/one/many document semantics where
  applicable, and JSON success returning exactly one document.

- Test `DocumentParsers.json(schema)` through Effect Schema JSON decoding rather
  than asserting private parsing implementation details.

- Test `DocumentParsers.schema(name, schema)` with already-materialized values,
  including decode failures and diagnostic naming.

- Test `DocumentFetchers.fileText(...)` with Effect platform filesystem
  services and stable resource fingerprint behavior.

- Test `DocumentFetchers.effect(...)` with a custom Effect service/layer to
  prove source authors can assemble resources through Effect dependencies.

- Test top-level selector typing and runtime behavior through a source that
  selects document items directly.

- Test nested selector typing and runtime behavior through a source that emits
  `{ parent, item }` payloads.

- Test that destination projection remains a pipeline concern by asserting the
  pipeline receives selected payloads and maps them to destination commands.

- Test scan lookup by identity over selected document items.

- Test direct lookup by identity with not-found returning `null`.

- Test direct lookup still parses, selects, derives identity, and rejects
  resources that do not contain the requested identity.

- Test duplicate identity failures for normal reads and identity lookup.

- Test content-hash versions use schema encoding and are stable across equivalent
  selected values.

- Test document source cursor progression across item windows, parsed document
  boundaries, fetcher cursor advancement, and zero-document resources.

- Test resource fingerprint restart behavior for partially consumed resources.

- Test parser failure diagnostics include parser-local facts and document source
  resource context.

- Test source payload schema validation through the existing runner boundary
  where possible, not only through private helpers.

- Reuse existing JSON source tests as behavioral prior art, but rewrite them
  around the document source architecture rather than preserving JSON-source-only
  design choices.

- Reuse existing CSV and source plugin tests only as runtime contract prior art.
  Do not merge CSV-specific row semantics into document source tests.

- Run package-scoped tests and type checks for the SDK package, plus formatting
  and whitespace checks for touched files.

## Out of Scope

- Implementing XML, SOAP, YAML, S3, database, or archive fetchers.

- Adding a public `httpText` convenience fetcher in the first slice.

- Adding streaming parser contracts.

- Implementing full JSONPath.

- Implementing jq-style mapping, filtering, joins, or root lookups in source
  configuration.

- Moving destination projection out of the pipeline.

- Replacing or rewriting the CSV source plugin.

- Building a plugin registry or serializable migration spec.

- Adding CLI output rendering for parser diagnostics.

- Changing the existing Source Plugin runtime contract.

- Changing run summary shape.

- Exporting internal schema cursor helpers as root public API.

## Further Notes

- This PRD follows the accepted ADR for document source fetchers and parsers and
  the document source design document.

- The main deep module opportunity is the document source composer: it should
  hide cursor-window adaptation, duplicate identity checks, lookup adaptation,
  selected payload schema construction, and source item assembly behind a small
  public `make` interface.

- The parser helper module should be small but strict. It owns schema-backed
  document validation and diagnostic normalization, not transport concerns.

- The fetcher helper module should keep IO and Effect dependency composition
  explicit. `fileText` proves local text resources; `effect` proves the
  bring-your-own-Effect resource assembly model.

- The selector/schema-cursor module is the likely type-system hotspot. Keep its
  runtime behavior simple and isolate type-level complexity from the source
  composer where possible.

- The first implementation should prove local JSON file behavior through the
  document source core and keep API convenience helpers for a later slice.
