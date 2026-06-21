# Document Source Design

Status: draft, with source identity authoring updated for
[ADR 0006](../adr/0006-scoped-pipeline-tracking-with-composite-identities.md).
Document source identity examples use the new `identity.id`,
`identity.schema`, and `identity.key` contract shape.

Audience: maintainers and migration authors working with first-party source
sources that read structured documents from files or remote APIs.

## Context

The SDK now has two related source shapes:

- The API source example fetches remote JSON through an Effect service, decodes
  response payloads, builds source identities and versions, and implements the
  durable source contract manually.
- The local JSON implementation reads a file, parses JSON, validates a
  document schema, selects items from a hierarchy, preserves optional parent
  context, and builds source items.

Those two implementations are solving the same middle problem: turn a fetched
resource into schema-backed source items. If we keep adding transport and format
combinations directly, we will drift toward separate sources for each
pair, such as JSON file, JSON API, XML file, XML API, and similar variants.

Drupal Migrate Plus has a useful prior art split: sources can combine a
transport-oriented data fetcher with a format-oriented data parser. We should
borrow that separation, but keep the Migrate SDK's Effect-native,
schema-backed, cursor-window source contract.

## Goals

- Compose resource fetching, document parsing, and item selection.
- Keep source items schema-backed from the document boundary through the
  migration pipeline.
- Preserve hierarchical context with an optional parent selector.
- Keep identity and version derivation explicit and durable.
- Share local JSON file and remote JSON API source behavior.
- Keep the existing `Source` runtime contract unchanged.
- Avoid format and transport combinations becoming separate implementation
  stacks.

## Non-Goals

- A generic low-code mapping DSL.
- jq-style transforms, filters, joins, or lookups outside the pipeline.
- Full JSONPath support as the primary public API.
- Replacing the CSV source.
- Streaming huge documents in the first slice.
- Supporting XML, SOAP, YAML, S3, or database fetchers in the first slice.

## Naming

The shared source is named `DocumentSource`.

In this context, a document is one structured resource or page after parsing. It
may come from a local JSON file, an HTTP response body, or a future resource
fetcher. It does not imply MongoDB, a document database, or an office document.

The public parts are:

- `DocumentFetcher`: retrieves resources for a parser.
- `DocumentParser`: parses and decodes fetched resources into a document schema.
- `selector`: selects source items from the decoded document.
- `identity`: derives durable source identity from the selected item.
- `version`: derives source version from the selected item.

`selector` is the top-level key because it names the operation the source owns.
`items` sounds like already-selected data and makes the configuration read less
clearly next to `fetcher`, `parser`, `identity`, and `version`.

## Component Graph

```mermaid
flowchart LR
  source["DocumentSource.make"] --> fetcher["DocumentFetcher"]
  fetcher -->|DocumentFetchResult<Resource, FetcherCursor>| parser["DocumentParser"]
  parser -->|readonly Document[]| selector["selector"]
  selector -->|"{ item } or { parent, item }"| identity["identity"]
  selector --> version["version"]
  identity --> item["SourceItem"]
  version --> item
  item --> runtime["SDK Source runtime"]
```

The public source configuration should stay shaped around the component graph:

```ts
DocumentSource.make({
  fetcher,
  parser,
  selector,
  identity,
  lookup,
  version,
});
```

## Public API Target

Top-level document selection:

```ts
const businessUnitsSource = DocumentSource.make({
  fetcher: DocumentFetchers.fileText({
    path: "./examples/document-source/companies.json",
    platform,
  }),
  parser: DocumentParsers.json(CompaniesDocument),
  selector: {
    item: (document) => document.businessUnits,
  },
  identity: {
    id: "business-unit@v1",
    schema: SourceIdentity.key("businessUnitKey", Schema.NonEmptyString),
    key: ({ item }) => item.key,
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
});
```

Nested document selection with parent context:

```ts
const tuple2 = <A, B>(first: A, second: B): readonly [A, B] => [
  first,
  second,
];

const contactsSource = DocumentSource.make({
  fetcher: DocumentFetchers.fileText({
    path: "./examples/document-source/companies.json",
    platform,
  }),
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
    key: ({ parent, item }) => tuple2(parent.key, item.key),
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
});
```

The process receives the selected shape:

```ts
const contactsMigration = MigrationDefinition.make({
  id: "import-company-contacts",
  source: contactsSource,
  store,
  process: (sourceItem) => {
    const { item, parent } = sourceItem.item;

    return destination.entries.upsert({
      businessUnitKey: parent.key,
      businessUnitName: parent.name,
      email: item.email,
      firstName: item.firstName,
      lastName: item.lastName,
    });
  },
});
```

The outer `sourceItem.item` is the existing runtime source payload envelope. The
inner `{ parent, item }` shape is the selected document payload.

The same migration can also be written inline:

```ts
const contactsMigration = MigrationDefinition.make({
  id: "import-company-contacts",
  source: contactsSource,
  store,
  process: ({ item: { item, parent } }) =>
    destination.entries.upsert({
      businessUnitKey: parent.key,
      businessUnitName: parent.name,
      email: item.email,
      firstName: item.firstName,
      lastName: item.lastName,
    }),
});
```

The source preserves parent context, but destination projection remains in the
process. The source does not extract arbitrary individual fields on behalf of a
destination.

## Future Effect-Native Fetchers

Convenience fetchers such as `fileText` should not become the only way to build
document sources. The lowest-level public escape hatch should be an
Effect-native fetcher helper whose only job is to run an Effect program and
return a resource for the parser:

```ts
const fetcher = DocumentFetchers.effect({
  cursorSchema: JsonPlaceholderPostCursor,
  read: (cursor) =>
    Effect.gen(function* () {
      const api = yield* JsonPlaceholderApi;
      const offset = cursor?.offset ?? 0;
      const ids = yield* api.listPostIds();
      const pageIds = ids.slice(offset, offset + 2);
      const posts = yield* Effect.forEach(
        pageIds,
        (id) => api.getPost(id),
        { concurrency: 2 }
      );

      return {
        resource: JSON.stringify({ posts }),
        nextCursor:
          offset + 2 < ids.length ? { offset: offset + 2 } : undefined,
      };
    }),
  layer: apiLayer,
});
```

The document source still composes that fetcher with an explicit parser,
selector, identity, lookup, and version:

```ts
const postsSource = DocumentSource.make({
  fetcher,
  parser: DocumentParsers.json(JsonPlaceholderPostsPage),
  selector: {
    item: (document) => document.posts,
  },
  identity: {
    id: "jsonplaceholder-post@v1",
    schema: SourceIdentity.key("postId", Schema.NonEmptyString),
    key: ({ item }) => String(item.id),
  },
  lookup: {
    kind: "direct",
    read: ({ key }) =>
      Effect.gen(function* () {
        const api = yield* JsonPlaceholderApi;
        const postId = Number(key);

        if (!Number.isInteger(postId)) {
          return null;
        }

        const post = yield* api.getPost(postId);

        return post === null
          ? null
          : JSON.stringify({ posts: [post] });
      }).pipe(Effect.provide(apiLayer)),
  },
  version: ({ item }) =>
    `jsonplaceholder-post:${item.id}:${item.title.length}:${item.body.length}`,
});
```

This gives API-backed sources the full power of Effect for HTTP clients,
services, retries, concurrency, pagination, request fan-out, test layers, and
resource assembly without forcing those concerns into a generic
`DocumentFetchers.httpText(...)` helper. `httpText` can still exist later as a
convenience helper for simple HTTP resources, but it should not be the power
API.

If an API client already returns materialized JavaScript values, the fetcher can
return those values directly instead of converting them back to JSON text:

```ts
const fetcher = DocumentFetchers.effect({
  cursorSchema: JsonPlaceholderPostCursor,
  read: (cursor) =>
    Effect.gen(function* () {
      const api = yield* JsonPlaceholderApi;
      const page = yield* api.listPosts(cursor);

      return {
        resource: { posts: page.posts },
        nextCursor: page.nextCursor,
      };
    }),
  layer: apiLayer,
});

const postsSource = DocumentSource.make({
  fetcher,
  parser: DocumentParsers.schema(
    "jsonplaceholder-posts",
    JsonPlaceholderPostsPage
  ),
  selector: {
    item: (document) => document.posts,
  },
  identity: {
    id: "jsonplaceholder-post@v1",
    schema: SourceIdentity.key("postId", Schema.NonEmptyString),
    key: ({ item }) => String(item.id),
  },
  lookup: { kind: "scan" },
  version: { kind: "content-hash" },
});
```

`DocumentParsers.schema(name, schema)` is the parser for already-materialized
resources. It preserves the parser as the schema-backed document boundary
without requiring every fetcher to return text.

## Selector Shape

The selector supports two author-facing modes:

```ts
type DocumentSelector<Document, Item> = {
  readonly item: (document: Document) => readonly Item[];
};
```

```ts
type DocumentSelectorWithParent<Document, Parent, Item> = {
  readonly parent: (document: Document) => readonly Parent[];
  readonly item: (parent: Parent) => readonly Item[];
};
```

The implementation may use schema cursor helper types internally to preserve
field-level inference while users write ordinary property access at the call
site:

```ts
type DocumentSelectorInput<Document, Selection> = {
  readonly item: (
    document: DocumentSchemaCursor<Document>
  ) => DocumentSchemaSelection<Selection>;
};
```

```ts
type DocumentSelectorWithParentInput<Document, ParentSelection, Selection> = {
  readonly parent: (
    document: DocumentSchemaCursor<Document>
  ) => DocumentSchemaSelection<ParentSelection>;
  readonly item: (
    parent: DocumentSchemaCursor<DocumentCursorFocus<ParentSelection>>
  ) => DocumentSchemaSelection<Selection>;
};
```

A top-level selector emits:

```ts
type SelectedItem<Item> = {
  readonly item: Item;
};
```

A nested selector emits:

```ts
type SelectedSubitem<Parent, Item> = {
  readonly parent: Parent;
  readonly item: Item;
};
```

The migration runtime then wraps that selected item in the normal source item
envelope. Migration code can destructure the selected payload from
`sourceItem.item`.

## Fetcher Shape

A document fetcher retrieves a resource for a parser. The fetcher does not
validate the document schema; schema validation belongs to the parser and the
source payload boundary. The first file fetcher should use Effect platform
services rather than Node APIs directly:

```ts
const fetcher = DocumentFetchers.fileText({
  path: "./companies.json",
  platform,
});
```

`fileText` is the first concrete helper because JSON parsing consumes a string
resource. It owns local file IO and text decoding concerns. A more general
`DocumentFetchers.file({ decode })` or public `ResourceDecoders` API can be
introduced later if multiple resource encodings need composition.

The generic shape should stay close to:

```ts
interface DocumentFetcher<Resource, Cursor> {
  readonly cursorSchema: Schema.Codec<Cursor, unknown, never, never>;
  readonly read: (
    cursor: Cursor | null
  ) => Effect.Effect<
    DocumentFetchResult<Resource, Cursor>,
    SourceError
  >;
}

interface DocumentFetchResult<Resource, Cursor> {
  readonly resource: Resource;
  readonly fingerprint?: string;
  readonly nextCursor?: Cursor | undefined;
}
```

The implementation may wrap fetcher cursors with item-window state so a single
large document can still be emitted in durable batches.

Remote fetchers can use Effect HTTP services, retries, timeouts, and test
layers through the future `DocumentFetchers.effect(...)` helper described
above. We should not freeze a dedicated HTTP convenience helper until real API
sources prove what should be abstracted.

## Identity Lookup

The document source must compile to the existing runtime `SourceLookupStrategy`.
There is no second lookup-kind system for fetchers. `lookup` is required on the
low-level `DocumentSource.make` API so scan-based identity reruns are an
explicit authoring choice.

Scan lookup reads through resources, parses documents, applies the selector,
derives identity, and returns the first selected source item whose derived
identity matches the requested source identity:

```ts
const source = DocumentSource.make({
  fetcher,
  parser,
  selector,
  identity,
  version,
  lookup: { kind: "scan" },
});
```

Direct lookup is a document-source option, not a fetcher-owned runtime flag:

```ts
const source = DocumentSource.make({
  fetcher,
  parser,
  selector,
  identity,
  version,
  lookup: {
    kind: "direct",
    read: (identity) => readPostResourceByIdentity(identity),
  },
});
```

The direct lookup read returns `Resource | null` to match the existing
`Source.readByIdentity` contract. `null` means the source item is not
found for the requested identity. Implementations may internally model
not-found as a typed error, but they must adapt that case to `null` at the
document-source boundary. Lookup failures such as unavailable credentials,
transport failures, invalid responses, or permission errors remain
`SourceError`.

The direct lookup read still returns a fetched resource. The document source must
parse it, select items, derive source identities, and verify the requested
identity matches a selected item. Direct lookup narrows the resource search; it
does not bypass parser, selector, identity, version, or Source Payload Schema
behavior.

Fetcher helpers may provide the underlying resource read used by direct
lookup, but the lookup declaration lives on `DocumentSource.make` and
compiles to the existing runtime `SourceLookupStrategy`.

Convenience fetchers such as `DocumentFetchers.fileText(...)` must not imply a
lookup strategy. Even local file sources should declare scan lookup at the
`DocumentSource.make` call site so identity lookup cost is visible in the
source configuration.

The configured document source reports the existing runtime lookup strategy:

```ts
type SourceLookupStrategy = "direct" | "scan";
```

This preserves current warnings and retry behavior for expensive scan-based
identity lookup.

Both scan and direct lookup must fail if the selected result set contains
duplicate source identities. Returning the first match would make reruns depend
on incidental source ordering. Duplicate identity is a source correctness error.

## Parser Shape

A document parser turns the fetched resource into a decoded document:

```ts
const parser = DocumentParsers.json(CompaniesDocument);
```

The generic shape should stay close to:

```ts
interface DocumentParser<Resource, Document> {
  readonly name: string;
  readonly documentSchema: Schema.Codec<Document, unknown, never, never>;
  readonly parse: (
    resource: Resource
  ) => Effect.Effect<readonly Document[], SourceError>;
}
```

`name` is a required diagnostic label. First-party parsers should set it to
values such as `"json"`, `"ndjson"`, or `"xml"` so parse and schema failures can
name the parser that failed. The document source core must not use `name` for
routing or behavior; custom parsers must provide their own label.

The parser exposes `documentSchema` because `DocumentSource.make` uses it
to build the schema cursor for `selector.parent` and `selector.item`. The
document schema should not be passed separately at the source level.

Parser dependencies follow the same ownership model as existing source
dependencies. The migration author or source author controls parser and fetcher
dependencies when constructing the configured source. The framework controls the
runtime boundary after that configured source is handed to a migration
definition.

For first-party parser helpers, the common case should require no parser
environment at execution time:

```ts
parser: DocumentParsers.json(CompaniesDocument)
```

If a parser needs services, such as an XML library, schema registry, or custom
decoder, those services should be selected or provided at parser/source
construction time. The document source can then provide those parser
dependencies before exposing its configured source layer. This mirrors
the API source example where an `apiLayer` is supplied by the caller and
provided inside the source implementation before the runtime sees the source
source.

If first-party helpers do not fit, migration authors can define their own
`DocumentFetcher` or `DocumentParser` and close over whatever dependencies they
need. That keeps extension points explicit without making the migration runner
aware of every parser-specific service.

The apparent platform asymmetry between `DocumentFetchers.fileText({ platform })`
and `DocumentParsers.json(schema)` is intentional. The first-party file fetcher
performs IO, so it needs a platform layer for filesystem and path services. The
first-party JSON parser is a pure string-to-schema decoder, so it does not need
an execution platform. Parsers that do need services should be custom parsers or
parser factories that close over or provide those dependencies at source
construction time.

The framework should not implicitly decide parser dependencies. It should call
the configured source, persist cursors, apply retries, record failures,
and run the pipeline. Parser-specific services are controlled by the configured
source, not by the migration runner.

Document parsers decode directly into the schema-backed `Document` type before
selectors run. Selectors should only operate on validated, typed documents. This
is what gives `selector.parent` and `selector.item` full TypeScript inference
from the configured document schema.

`DocumentParsers.json(schema)` accepts a string resource and should use
`Schema.fromJsonString(schema)` as the implementation boundary. It should not
manually `JSON.parse` and then apply ad hoc validation. Parse and validation
stay inside Effect Schema's decode path. Byte decoding and UTF-8 BOM handling
belong in a text fetcher or resource-decoder helper, not in the JSON parser.
Transport metadata preconditions, such as HTTP status or content type, also
belong to the fetcher or resource decoder unless the resource value passed to
the parser intentionally includes that metadata. A parser validates the resource
value it receives and the decoded document schema; it should not become
transport-aware by default.

Parsers may emit zero, one, or many parsed documents from one fetched resource.
An empty collection is valid for the generic parser contract because paged APIs,
feeds, archives, or line-oriented resources can fetch a resource that contains
no documents. The document source treats that resource as exhausted and advances
to the next fetcher cursor without producing source items.

`DocumentParsers.json(schema)` emits exactly one document on success. If the
JSON root is an array, that array is still the one parsed document. The return
type is a singleton `readonly Document[]` because the generic parser abstraction
supports multi-document resources; the array is not part of the JSON document
model.
Multi-document JSON-like formats should use separate parsers such as
`DocumentParsers.ndjson(schema)` or `DocumentParsers.jsonSequence(schema)`,
because they have different resource boundaries and error reporting. Future
parsers such as archives, multipart payloads, or feeds may also emit multiple
documents. The document source core normalizes parser output to
`readonly Document[]` and owns the `documentIndex` cursor position across that
parsed document list.

The first document source design does not expose a streaming parser contract.
Parsers return a readonly document collection for each fetched resource. If a
format needs streaming semantics later, it should be added as a separate parser
contract after we have a concrete large-resource use case.

Content-hash versions should hash the schema-encoded selected source item, not
the raw JavaScript object with ad hoc `JSON.stringify`.

## Parser Error Output

Parser failures are source-read failures and should surface as
`SourceError` at the source boundary. This does not mean schema
messages are only a logging concern. Parser helpers must preserve useful parse
and schema diagnostics in the `SourceError` message or cause so CLI,
SDK, and logs can render actionable output.

Document parser errors happen before the document source has selected source
items. When a parser fails during cursor discovery, the runner usually does not
know which source identities are affected, so the migration definition run
fails rather than recording item-level error details.

Once the document source has built source items with identities and versions,
the existing Source Payload Schema boundary still applies. If a selected source
item payload fails that schema, the runner can record durable Migration Item
Error Details for that source identity.

`DocumentParsers.json(schema)` should distinguish JSON parse failures from
schema decode failures in its diagnostics. Schema decode failures should expose
the relevant schema issue messages and paths, not only a generic "invalid JSON
document" message. Parser diagnostics should include the parser `name`.

Parser errors should describe parser-local facts: parser name, parse failure,
schema issue, schema path, and parser-known document position when a
multi-document parser can identify it. Fetcher and resource context belongs to
the document source. When surfacing a parser failure, the document source should
annotate it with context such as file path, URL, fetcher cursor, document index,
or resource fingerprint. That keeps parsers reusable across local files, HTTP
responses, and future fetcher implementations.

## Cursor Shape

The document source owns one durable source cursor envelope. Fetchers own
external resource pagination, but they do not own selected-item progress inside
the parsed document. Parsers do not get an independent durable cursor.

```ts
type DocumentSourceCursor<FetcherCursor> = {
  readonly fetcherCursor: FetcherCursor | null;
  readonly documentIndex: number;
  readonly itemIndex: number;
  readonly resourceFingerprint?: string;
};
```

`fetcherCursor` is the cursor used to fetch the current resource or page. A
fetcher may return the next fetcher cursor for the following resource, but the
document source advances to it only after it has exhausted every parsed document
and selected item in the current resource.

The progression order is:

```txt
fetcherCursor -> fetch resource/page
resource -> parser -> parsed documents
documentIndex -> choose parsed document
selector -> selected items
itemIndex -> choose item window
```

If a read stops halfway through selected items, the next source cursor keeps the
same `fetcherCursor` and `documentIndex`, then advances `itemIndex`.

If a read finishes one parsed document but not the full resource, the next
source cursor keeps the same `fetcherCursor`, advances `documentIndex`, and
resets `itemIndex`.

If a read finishes the whole resource, the next source cursor switches to the
fetcher's next cursor, then resets `documentIndex` and `itemIndex`.

`resourceFingerprint` records the identity of the fetched resource content while
the document source cursor points inside that resource. If the same
`fetcherCursor` later returns a different fingerprint, the document source
should restart that resource at `documentIndex: 0` and `itemIndex: 0` rather
than resuming into stale offsets. This protects file and page-backed sources
from skipping or duplicating selected items when the underlying resource changes
between runs.

A fetch result's `fingerprint` becomes the cursor's `resourceFingerprint` when
the next source cursor still points inside that same resource.

For a local file, the fingerprint can be a content hash of the file bytes. For
an HTTP resource, it may come from stable response metadata such as an ETag or
from a body hash. If a fetcher cannot provide a fingerprint, the document source
can still run, but it cannot detect that a partially consumed resource changed
under the same fetcher cursor.

The source item itself should not carry this discovery cursor. Source items keep
their durable `identity`, `version`, and selected `item` payload. The source
cursor records discovery position; `readByIdentity` remains the mechanism for
failed-item reruns and identity-targeted runs.

The cursor schema can be derived from the fetcher's cursor schema:

```ts
const makeDocumentSourceCursor = <FetcherCursor>(
  fetcherCursorSchema: Schema.Codec<FetcherCursor, unknown, never, never>
) =>
  Schema.Struct({
    fetcherCursor: Schema.NullOr(fetcherCursorSchema),
    documentIndex: Schema.Int,
    itemIndex: Schema.Int,
    resourceFingerprint: Schema.optional(Schema.String),
  });
```

## Source Item Construction

`DocumentSource.make` owns the common path:

1. Read a resource through the fetcher.
2. Parse and decode one or more documents through the parser.
3. Select source items with `selector.item`, optionally under
   `selector.parent`.
4. Decode selected items with the schema inferred from the selector.
5. Build source identities and versions.
6. Fail on duplicate identities in the selected document window.
7. Return a normal configured source.

The generated source still exposes the existing durable runtime behavior:

- cursor reads are windowed;
- identity lookup is required;
- lookup strategy is declared through the existing `SourceLookupStrategy`;
- source cursor schema is encoded by the configured source;
- source payload schema is carried by the configured source.

## Implementation Plan

The next implementation slice should not replace every source at once.

1. Extract the schema cursor, document selection, selected item decoding,
   identity, version, content hash, and duplicate identity behavior from
   existing JSON-oriented source code into an internal document-source core.
2. Add `DocumentFetchers.file` and `DocumentParsers.json`, then wire a local
   JSON document source through `DocumentSource.make`.
3. Refactor the API source example so its remote JSON flow uses the same
   document-source core for parsing, selection, identity, and version.
4. Keep `DocumentSource` internal until the API holds up in both local
   file and remote API examples.
5. Expose a public subpath such as `migrate-sdk/sources/document` only after
   the document source proves the ergonomics.

## Relationship To CSV

CSV should not be forced through the document source API in the first version.

CSV has row-oriented semantics that are important to expose directly: dialect,
headers, blank rows, row width, identity columns, and version columns. The CSV
source may share internal utilities later, but its public API should remain
record/table-oriented.

## Open Questions

- Should HTTP pagination be owned entirely by a fetcher, or should the document
  source expose a pagination hook that can inspect the parsed document?
- Should a fetcher return bytes, strings, or a typed resource envelope for local
  files and HTTP responses?
- Do XML and SOAP need parser-specific selector behavior, or can they use the
  same schema cursor model after parsing?
