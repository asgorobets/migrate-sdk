# Document Source Fetchers And Parsers

We will introduce a document source architecture for first-party sources that
fetch structured resources, parse them into schema-backed documents, and select
source items from those documents. This avoids multiplying sources by
transport and format while preserving the existing durable source
contract.

## Status

Accepted

Amended by [ADR 0006](./0006-scoped-pipeline-tracking-with-composite-identities.md):
the document source decision remains accepted, and the public identity examples
now use the ADR 0006 source identity contract shape with `identity.id`,
`identity.schema`, and `identity.key`.

## Considered Options

- Keep one source per transport and format combination, such as JSON
  file, JSON API, XML file, and XML API.
- Introduce a composable source architecture that separates resource fetching,
  document parsing, schema-backed item selection, identity, and version
  derivation.

## Decision

We will use the name `DocumentSource` for the shared first-party source
architecture.

A document source fetches one structured resource or page at a time, parses it
with a schema-backed parser into one or more documents, selects source items
from those parsed documents, and adapts the result to the existing
`Source` cursor-window contract.

The public authoring model is:

```ts
DocumentSource.make({
  fetcher: DocumentFetchers.fileText({ path, platform }),
  parser: DocumentParsers.json(CompaniesDocument),
  selector: {
    parent: (document) => document.businessUnits,
    item: (businessUnit) => businessUnit.contacts,
  },
  identity: {
    id: "business-unit-contact@v1",
    schema: SourceIdentity.tuple([
      SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
      SourceIdentity.part("contactKey", Schema.NonEmptyString),
    ]),
    key: ({ parent, item }) => [parent.key, item.key] as const,
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
});
```

`fetcher` owns retrieving resources from a local file, HTTP endpoint, or future
resource location. `parser` owns turning the fetched resource into decoded
documents. `selector` owns selecting the source item collection from each
decoded document and may also select a parent collection when the pipeline needs
hierarchical context. `identity` and `version` derive durable source identity
and source version from the selected source item shape.

The selector key is top-level and uses `selector.item` plus optional
`selector.parent`. We will not use `items` as the top-level key for this
architecture because it names the selected data rather than the source-owned
selection operation.

The selected pipeline-facing source item shape is:

```ts
{ item }
```

or:

```ts
{ parent, item }
```

The migration pipeline remains responsible for destination projection and
mapping. The document source does not expose a field-picking API, jq-style
mapping, or destination-specific projection outside the pipeline.

The existing durable source boundary remains unchanged:

- `read(cursor)` returns one cursor window and an optional next cursor.
- `readByIdentity(identity)` receives a decoded source identity target and is
  required for reruns and targeted runs.
- The document source requires an explicit lookup configuration that compiles
  to the existing runtime `SourceLookupStrategy`.
- Source cursor encoding belongs to the configured source.
- Source identity and version are normalized by the SDK boundary.

Existing JSON-oriented source code should move toward this architecture so
local JSON files and remote JSON APIs share parsing, schema-backed selection,
identity, version, and duplicate identity behavior.

CSV remains a separate first-party source for now. CSV is primarily a
row-oriented table format with dialect, header, blank-row, and column-width
semantics that should stay explicit in the CSV source API.

## Consequences

- The SDK avoids a combinatorial set of sources for every transport and
  format pair.
- Local files and remote APIs can share schema-backed document parsing and item
  selection behavior.
- API-backed sources can use custom or effect-native fetchers for HTTP access,
  retries, pagination, concurrency, and multi-call resource assembly, while
  parser, selector, identity, version, and lookup adaptation remain shared
  document-source behavior.
- The document source architecture can borrow the useful fetcher/parser split
  from Drupal Migrate Plus without adopting Drupal's iterator and field-mapping
  source model.
- First-party JSON source behavior such as schema-backed content hashing,
  duplicate identity checks, selector typing, and parent context can live in one
  reusable implementation.
- Fetchers can remain Effect-native through services and layers for filesystem,
  HTTP, retries, timeouts, and test doubles.
- Fetchers and resource decoders own transport metadata checks such as HTTP
  status and content type. Parsers validate the resource value and document
  schema they receive.
- First-party fetcher helpers may expose platform or client layers because they
  perform IO. Pure parser helpers, such as JSON string parsing, do not need a
  platform layer; dependency-heavy parsers remain possible through custom parser
  factories.
- Parser and fetcher dependencies are chosen by the migration author or source
  author while constructing the configured source. The migration runner executes
  the configured source layer; it does not implicitly provide
  parser-specific services.
- Parsers expose a required diagnostic `name`, but parser labels do not affect
  source behavior.
- Parser output is a readonly document collection per fetched resource. The
  generic parser contract may return zero documents; JSON parser success returns
  exactly one document. A streaming parser contract is out of scope until there
  is a concrete large-resource use case.
- Parser errors describe parser-local facts; the document source wraps them
  with fetcher and resource context such as file path, URL, cursor, or resource
  fingerprint.
- Parser-specific result shapes should not leak into migration author APIs.
- The public API must clearly define "document" as a structured resource or
  page, not specifically a document database record or office document.
- Pagination, direct identity lookup, and scan lookup remain source concerns
  that the document source adapts to the existing runtime contract.
- The document source reports the existing `SourceLookupStrategy`; document
  fetchers do not introduce a second lookup-kind concept.
- The document source owns one durable cursor envelope that combines fetcher
  pagination, parsed document index, and selected item index.
