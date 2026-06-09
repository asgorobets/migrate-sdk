# Define SQL Source Contract And Core Types

Status: ready-for-human

## Parent

[SQL Source Plugin](../PRD.md)

## What to build

Define the public and internal contracts needed for the raw SQL source without completing SQL execution. This slice should make the SQL source API shape real and type-checkable: required client layer, required batch size, statement-builder callbacks, Source Payload Schema input typing, read-only source rows, Result-style metadata extraction, and Source Identity / Source Version / Source Cursor metadata.

This slice should also refine the core source schema typing enough that a source plugin can distinguish the source-native payload input type from the decoded pipeline-facing Source type while preserving existing source plugin behavior.

## Acceptance criteria

- [x] The source plugin contract can preserve the encoded/source-native input side of the Source Payload Schema while still exposing the decoded Source type to pipelines.
- [x] Existing in-memory and CSV source plugins continue to compile without changing their public behavior.
- [x] `SqlSourcePlugin.make` has a typed options contract for `clientLayer`, `batchSize`, `cursorSchema`, `sourceSchema`, `read`, `lookup`, and `getSourceMetadata`.
- [x] `clientLayer` is required and represents a layer that provides Effect SQL `SqlClient`.
- [x] `batchSize` is required at the API boundary.
- [x] Read and lookup callbacks are typed as SQL statement builders, not arbitrary Effect programs.
- [x] The row type passed to `getSourceMetadata` comes from the encoded/input side of `sourceSchema`.
- [x] Rows passed to `getSourceMetadata` are read-only.
- [x] `getSourceMetadata` returns a Result-style success or error value.
- [x] Source metadata success values contain Source Identity input, Source Version input, and Source Cursor.
- [x] Metadata extraction context includes page-local row index for diagnostics only.
- [x] The SQL source remains scaffolded if execution is not implemented in this slice, but the new contract is represented in tests or type assertions.
- [x] Public exports and subpath exports expose only the intended SQL source API.

## Blocked by

None - can start immediately
