# Compose Document Source From Fetcher And Parser

Status: ready-for-human

## Parent

[Document Source Plugin](../PRD.md)

## What to build

Compose document fetchers and document parsers into a configured Source Plugin.
This slice is the first end-to-end document source implementation: a fetcher
provides resources, a parser decodes documents, selectors choose source item
payloads, identity and version are derived, lookup is adapted to the existing
runtime Source Lookup Strategy, and cursor windows are emitted through the
existing Source Plugin contract.

This slice should include top-level and nested parent/item selectors, scan and
direct lookup, duplicate identity correctness, document source cursor progress,
and resource context wrapping for parser failures. Diagnostics are part of this
slice's correctness, not a follow-up design ticket.

## Acceptance criteria

- [x] `DocumentSourcePlugin.make` composes a fetcher, parser, selector,
      identity, lookup, and version into the existing configured Source Plugin
      runtime shape.
- [x] Top-level selectors emit selected payloads shaped as `{ item }`.
- [x] Nested selectors emit selected payloads shaped as `{ parent, item }`.
- [x] Selector callback authoring is inferred from the parser document schema.
- [x] The transformation pipeline receives the normal source item envelope whose
      payload is the selected document payload.
- [x] Destination projection remains in the transformation pipeline and is not
      moved into source configuration.
- [x] Source identity is derived from explicit identity configuration.
- [x] Source version is derived from explicit version configuration.
- [x] Scan lookup reads resources, parses documents, applies selectors, derives
      identities, and matches the requested source identity.
- [x] Direct lookup reads a resource by identity and still parses, selects,
      derives identity, and verifies that the requested identity is present.
- [x] Direct lookup not-found returns `null` at the document source boundary.
- [x] Direct lookup failures remain source plugin failures.
- [x] Duplicate selected source identities fail for normal reads and lookup.
- [x] The document source owns one cursor envelope combining fetcher cursor,
      parsed document index, selected item index, and optional resource
      fingerprint.
- [x] Zero-document parser output exhausts the current resource and advances to
      the next fetcher cursor without emitting source items.
- [x] Parser failures are wrapped with document source resource context such as
      resource identity, fetcher cursor, document index, or fingerprint when
      available.
- [x] Tests cover an end-to-end file text + JSON source with both top-level and
      nested selectors.

## Blocked by

- [Document Fetcher API And File Text Fetcher](01-document-fetcher-api-and-file-text-fetcher.md)
- [Document Parser API And JSON Parser](02-document-parser-api-and-json-parser.md)
