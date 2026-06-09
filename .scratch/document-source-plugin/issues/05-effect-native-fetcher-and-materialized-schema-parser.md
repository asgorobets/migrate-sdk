# Effect-Native Fetcher And Materialized Schema Parser

Status: ready-for-agent

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

- [ ] `DocumentFetchers.effect(...)` accepts a cursor schema and an Effectful
      read function that returns a Document Fetch Result.
- [ ] The effect-native fetcher can be provided with caller-selected dependency
      layers at source construction time.
- [ ] The migration runner does not implicitly decide or provide fetcher/parser
      dependencies.
- [ ] The effect-native fetcher supports resources assembled from multiple
      Effect calls.
- [ ] `DocumentParsers.schema(name, schema)` validates already-materialized
      resource values against a document schema.
- [ ] Schema parser diagnostics include the required parser name.
- [ ] Already-materialized resources do not need to be converted back to JSON
      text before validation.
- [ ] Tests prove a custom Effect service/layer can assemble a resource and feed
      it through the document source composer.
- [ ] Tests cover schema parser success and schema parser decode failures.
- [ ] No public `httpText` convenience helper is added in this slice.

## Blocked by

- [Rewrite JSON File Source Examples Onto Document Source](04-rewrite-json-file-source-examples-onto-document-source.md)
