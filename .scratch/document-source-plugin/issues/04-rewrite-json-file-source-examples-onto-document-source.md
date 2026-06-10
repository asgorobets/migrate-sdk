# Rewrite JSON File Source Examples Onto Document Source

Status: ready-for-human

## Parent

[Document Source Plugin](../PRD.md)

## What to build

Rewrite the existing JSON file source examples and JSON-file-oriented behavior
onto the document source model. The examples should demonstrate one local JSON
document powering multiple migrations through different selectors, including a
nested selector that makes parent fields obvious in the pipeline.

This slice proves that the current JSON file source mental model has been
decomposed into file text fetcher + JSON parser + document source composer,
without leaking document-source internals through the root public API.

## Acceptance criteria

- [x] Existing JSON file source examples are rewritten to use the document
      source authoring model.
- [x] The example uses one JSON document for multiple migrations.
- [x] At least one example migration selects top-level items.
- [x] At least one example migration selects nested items with parent context.
- [x] Parent fields are used visibly in the transformation pipeline.
- [x] Destination projection remains in the pipeline.
- [x] Example fixture data stays neutral and avoids project-specific customer
      import details.
- [x] Public examples import only intended public source APIs.
- [x] Document-source-specific internals are not exported from the root SDK
      entrypoint.
- [x] Existing JSON-file-source behavior covered by examples is preserved or
      intentionally migrated to the new document source shape.
- [x] The example command and relevant tests pass.

## Blocked by

- [Compose Document Source From Fetcher And Parser](03-compose-document-source-from-fetcher-and-parser.md)
