# Document Parser API And JSON Parser

Status: ready-for-agent

## Parent

[Document Source Plugin](../PRD.md)

## What to build

Introduce the Document Parser contract and the JSON parser helper. This slice
extracts JSON parsing and document schema validation from the current JSON file
source shape without building the full document source composer yet.

The parser contract should require a diagnostic parser name, expose the
document schema, and parse a resource into a readonly collection of decoded
documents. The JSON parser should parse string resources through Effect Schema's
JSON decoding boundary and return exactly one document on success, even when
the JSON root is an array.

## Acceptance criteria

- [ ] A Document Parser contract exists with required diagnostic name,
      document schema, and parse operation.
- [ ] Parser names are diagnostic only and are not used for routing or behavior.
- [ ] The parser contract returns a readonly document collection.
- [ ] The JSON parser helper accepts a document schema and string resource.
- [ ] The JSON parser uses Effect Schema's JSON decoding boundary rather than
      ad hoc JSON parsing plus separate validation.
- [ ] JSON parser success returns exactly one parsed document.
- [ ] A JSON root array is treated as one parsed document, not as multiple
      resource documents.
- [ ] JSON syntax failures and schema decode failures are distinguishable in
      diagnostics.
- [ ] Schema decode diagnostics include useful issue messages and paths where
      available.
- [ ] Parser failures remain parser-local and do not include file, URL, or
      fetcher cursor context.
- [ ] Tests cover success, root arrays, syntax failures, schema failures,
      parser names, and readonly output semantics.

## Blocked by

None - can start immediately
