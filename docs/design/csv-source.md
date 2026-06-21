# CSV Source Design

Status: draft, with source identity authoring updated for
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md).
CSV identity examples use the new `identity.id`, `identity.schema`, and
`identity.key` contract shape.

Audience: maintainers and migration authors working on `CsvSource`.

## Goals

- Read local UTF-8 CSV files through an explicit platform layer.
- Keep dialect, header, blank-row, identity, and version choices explicit.
- Emit stable Source Identity and Source Version values for each CSV row.
- Emit source-native row values for Source Payload Schema decoding.
- Support cursor progress and scan-based identity lookup.

## Non-Goals

- Spreadsheet formats such as XLSX, ODS, or Google Sheets.
- Remote URLs, authentication, fetch retry, or cache semantics.
- CSV-specific migration DSLs such as `defineCsvMigration`.
- Generated UUID identity for always-new imports.
- A separate CSV adapter package.

## Public API

`CsvSource.make` configures a path-backed CSV source:

```ts
const source = CsvSource.make({
  path: "bookstore-book-catalog.csv",
  platform: csvPlatform,
  dialect: { kind: "standard" },
  emptyRows: { kind: "skip" },
  headers: { kind: "from-row", rowIndex: 2 },
  identity: CsvIdentity.columns({
    id: "book-format@v1",
    columns: ["book_id", "format"],
  }),
  version: { kind: "column", column: "catalog_version" },
  sourceSchema: CsvBookSource,
});
```

All user choices that affect source semantics are required:

```ts
interface CsvSourceOptions<Source, IdentityKey = unknown> {
  readonly path: string;
  readonly platform: CsvSourcePlatform;
  readonly dialect: CsvDialect;
  readonly emptyRows: CsvEmptyRows;
  readonly headers: CsvHeaders;
  readonly identity: CsvIdentityDefinition<IdentityKey>;
  readonly version: CsvVersion;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
}
```

`identity` should normally be produced by `CsvIdentity.column(...)` or
`CsvIdentity.columns(...)`; migration authors should not need to construct the
low-level schema-backed identity definition by hand.

The source factory may still derive mechanical details such as cursor schema,
scan lookup strategy, and the canonical row-hash algorithm.

## Package Location

`CsvSource` lives in the main SDK package:

```txt
packages/migrate-sdk/src/sources/csv/
```

The SDK should remain one installable package for core types, runtime helpers,
and first-party sources and destinations as long as possible. Subpath exports
can be introduced later, but they should still point into the same package:

```ts
import { CsvSource } from "migrate-sdk/sources/csv";
```

## File Input

`path` is a local filesystem path in v1. Relative paths resolve through the
provided `Path` platform service. Diagnostics should include the resolved path
when a file read fails.

The CSV source reads UTF-8 files only. A leading UTF-8 BOM is stripped before
header handling so the first column name is not polluted by BOM bytes.

The path-backed source accepts an explicit `FileSystem | Path` platform layer.
The CSV module must not import Node.js APIs directly.

## Dialect

The public API uses migration-author terms, not parser-specific option names:

```ts
type CsvDialect =
  | {
      readonly kind: "standard";
    }
  | {
      readonly kind: "custom";
      readonly separator: string;
    };
```

`standard` is ordinary comma-separated CSV. `custom` is for sources that use a
different separator, such as `;` or tab.

Custom quote and escape characters are not supported in v1.

## Headers

CSV headers are explicit:

```ts
type CsvHeaders =
  | {
      readonly kind: "from-row";
      readonly rowIndex: number;
    }
  | {
      readonly kind: "provided";
      readonly columns: readonly string[];
      readonly dataStartRowIndex: number;
    };
```

`from-row` reads column names from a row in the file. Data starts on the next
row. This supports CSV exports with preamble rows.

`provided` gets column names from TypeScript configuration. `dataStartRowIndex`
is still required so headerless files and files with preamble rows are both
explicit.

Header names are metadata. Trim them before blank and duplicate checks. Do not
globally trim payload cells.

Runtime header discovery does not drive TypeScript inference. TypeScript
inference comes from `sourceSchema`.

## Rows

The CSV source builds source-native row objects from configured columns:

```ts
{
  book_id: "BOOK-001",
  format: "paperback",
  price: "34.95"
}
```

Payload values remain strings until `sourceSchema` decodes them at the runtime
boundary. For example, `Schema.NumberFromString` can turn CSV string values into
pipeline-facing numbers.

Blank row handling is explicit:

```ts
type CsvEmptyRows =
  | {
      readonly kind: "skip";
    }
  | {
      readonly kind: "error";
    };
```

A blank row means every parsed cell is empty after trimming. `skip` ignores the
row. `error` fails source discovery.

Row width mismatch is a source read failure in v1. A data row must have exactly
the same number of cells as the configured headers.

## Identity

The CSV source must produce a non-empty Source Identity before the runtime can
record durable item state:

```ts
type CsvIdentityDefinition<IdentityKey> = {
  readonly id: SourceIdentityContractId;
  readonly schema: SourceIdentitySchema<IdentityKey>;
  readonly key: {
    readonly kind: "columns";
    readonly columns: readonly string[];
  };
};
```

Migration authors should construct this definition through CSV-native helpers:

```ts
identity: CsvIdentity.column({
  id: "article@v1",
  column: "id",
})
```

```ts
identity: CsvIdentity.columns({
  id: "book-format@v1",
  columns: ["book_id", "format"],
})
```

`identity.key.columns` is the only v1 identity derivation strategy. The CSV
source converts one column into `SourceIdentity.key(...)` and multiple columns
into `SourceIdentity.tuple(...)`, using `Schema.NonEmptyString` for each raw CSV
identity column. The source trims identity values, rejects empty values, and
decodes the derived key through the generated `identity.schema` before emitting
the source item.

Single-column identity uses the trimmed value. Composite identity uses the
configured tuple order. This is the internal shape produced by
`CsvIdentity.columns(...)`:

```ts
identity: {
  id: "book-format@v1",
  key: { kind: "columns", columns: ["book_id", "format"] },
  schema: SourceIdentity.tuple([
    SourceIdentity.part("book_id", Schema.NonEmptyString),
    SourceIdentity.part("format", Schema.NonEmptyString),
  ]),
}
// Source Identity material: ["BOOK-001","paperback"]
```

Missing or empty configured identity values are source read failures. Duplicate
Source Identity values in the same file are also source read failures.

## Version

Version is required because it controls durable skip/update behavior:

```ts
type CsvVersion =
  | {
      readonly kind: "column";
      readonly column: string;
    }
  | {
      readonly kind: "row-hash";
    };
```

`version.column` is preferred when the CSV has a real revision, timestamp,
checksum, or updated-at field. Trim the configured version column value before
checking emptiness.

`version.row-hash` hashes the parsed source-native row using every configured
CSV column in configured column order. It does not include row number, file
fingerprint, cursor position, diagnostics, or decoded `sourceSchema` values.

Do not default omitted `version` to `row-hash`; row-hash is a valid strategy,
but it must be an explicit migration-author choice.

## Cursor And Lookup

The CSV cursor stores file content identity and row progress:

```ts
const CsvSourceCursor = Schema.Struct({
  fileFingerprint: Schema.String,
  nextRowIndex: Schema.Int,
});
```

`fileFingerprint` is a hash of the CSV file bytes. If the fingerprint matches
the stored cursor, reading resumes from `nextRowIndex`. If the fingerprint
changes, discovery resets to the first data row. Previously processed unchanged
rows are then skipped by normal Source Version behavior.

CSV identity lookup is scan-based in v1:

```ts
lookupStrategy: "scan";
```

`readByIdentity` scans the current CSV file for a matching Source Identity. If a
previously migrated Source Identity no longer exists in the current file, it
returns `null`. Removing durable mapping state for orphaned destinations is a
runtime/SDK command concern, not a CSV source concern.

## Errors

Source read failures fail the migration definition run before destination calls:

- missing or unreadable file
- non-UTF-8 input
- malformed CSV
- blank or duplicate header name
- missing configured identity or version column
- row width mismatch
- blank identity value
- blank configured version value
- duplicate Source Identity in the file

Rows with a valid Source Identity and Source Version can still become durable
item failures later if `sourceSchema` decoding fails.

CSV diagnostics should include source coordinates when known:

- `rowIndex` is zero-based and matches configuration.
- `lineNumber` is one-based and matches editors/spreadsheet tools.
- `column` names the configured column when relevant.

Coordinates are diagnostics only. Do not inject row indexes, line numbers, or
column diagnostics into `source.item`.

## Implementation Notes

The parser is an internal dependency. The public CSV API must not mirror parser
option names or expose parser result shapes.

The v1 implementation uses Papa Parse in array-row mode. The SDK owns header
validation, row-width validation, empty-row policy, identity extraction, and
version extraction. Any parser errors are treated as source read failures.

Row hashes and file fingerprints use Web Crypto SHA-256. Runtimes without
`globalThis.crypto.subtle` are unsupported until the SDK introduces a portable
hash service.

## Fixture

The v1 fixture is one owned bookstore book catalog:

```txt
packages/migrate-sdk/src/sources/csv/fixtures/bookstore-book-catalog.csv
```

It models books as ecommerce products and carries author relationship fields
such as `primary_author_id`, `primary_author_name`, `co_author_ids`, and
`co_author_names`. Those fields remain source-native row data. The CSV source
does not split rows into related book and author entities; that belongs to
migration pipelines and destinations.

The fixture covers:

- skipped preamble rows before the header row
- repeated book IDs across multiple product formats
- composite Source Identity from `book_id` and `format`
- explicit Source Version from `catalog_version`
- author relationship columns
- quoted commas
- escaped quotes
- JSON-like cell content with escaped quotes
- multiline descriptions
- a blank spreadsheet-export row ignored by `emptyRows.skip`

## Deferred

These are not part of the v1 API:

- remote CSV sources
- alternate encodings and encoding detection
- streaming as a public API
- custom quote and escape characters
- comments or interleaved preamble rows
- unsafe identity strategies such as row number or row hash identity
- direct indexed lookup
- large-file fingerprint optimization
