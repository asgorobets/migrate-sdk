# Effect-Native Fetcher And Materialized Schema Parser

Status: ready-for-human

## Parent

[Document Source Plugin](../PRD.md)

## What to build

Add the broader Effect-native extension points after the local JSON file rewrite
has proved the document source core. This slice introduces the low-level
`DocumentFetchers.effect(...)` helper and `DocumentParsers.schema(name, schema)`
for already-materialized resource values.

The goal is to let source authors assemble resources with arbitrary Effect
services, layers, retries, concurrency, pagination, and multi-call API fan-out
without forcing those use cases through a generic HTTP text helper.

## Acceptance criteria

- [x] `DocumentFetchers.effect(...)` accepts a cursor schema and an Effectful
      read function that returns a Document Fetch Result.
- [x] The effect-native fetcher can be provided with caller-selected dependency
      layers at source construction time.
- [x] The migration runner does not implicitly decide or provide fetcher/parser
      dependencies.
- [x] The effect-native fetcher supports resources assembled from multiple
      Effect calls.
- [x] `DocumentParsers.schema(name, schema)` validates already-materialized
      resource values against a document schema.
- [x] Schema parser diagnostics include the required parser name.
- [x] Already-materialized resources do not need to be converted back to JSON
      text before validation.
- [x] Tests prove a custom Effect service/layer can assemble a resource and feed
      it through the document source composer.
- [x] Tests cover schema parser success and schema parser validation failures.
- [x] No public `httpText` convenience helper is added in this slice.

## Blocked by

- [Rewrite JSON File Source Examples Onto Document Source](04-rewrite-json-file-source-examples-onto-document-source.md)
