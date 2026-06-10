import { Effect, Schema, SchemaAST } from "effect";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  type SourcePluginImplementation,
} from "../../domain/definition.ts";
import { SourcePluginError } from "../../domain/errors.ts";
import type {
  SourceIdentityInput,
  SourceVersionInput,
} from "../../domain/ids.ts";
import type { SourceItemInput } from "../../domain/source.ts";
import type {
  DocumentFetcher,
  DocumentFetchResult,
} from "./document-fetcher.ts";
import type { DocumentParser } from "./document-parser.ts";

export type DocumentSourceSchema<Decoded = unknown> = Schema.Codec<
  Decoded,
  unknown,
  never,
  never
>;

type DocumentSourceCursorFocus<Value> =
  Value extends ReadonlyArray<infer Element> ? Element : Value;

type DocumentSourceObjectKeys<Value> = Extract<keyof Value, string>;

export type DocumentSourceIdentityScalar = boolean | number | string;

export type DocumentSourceIdentityValue =
  | DocumentSourceIdentityScalar
  | readonly DocumentSourceIdentityScalar[];

export type DocumentSourceDirectLookupResult<Resource, FetcherCursor> =
  DocumentFetchResult<Resource, FetcherCursor>;

export interface DocumentSourceCursor<FetcherCursor> {
  readonly fetcherCursor: FetcherCursor | null;
  readonly nextDocumentIndex: number;
  readonly nextItemIndex: number;
  readonly resourceFingerprint?: string | undefined;
}

export interface DocumentSourcePathSegment {
  readonly key: string;
  readonly kind: "array" | "property";
}

interface DocumentSourceSchemaCursorState<Source> {
  readonly path: readonly DocumentSourcePathSegment[];
  readonly schema: DocumentSourceSchema<Source>;
}

export interface DocumentSourceSelectedItem<Item> {
  readonly item: Item;
}

export interface DocumentSourceSelectedSubitem<Parent, Item> {
  readonly item: Item;
  readonly parent: Parent;
}

interface DocumentSourceCompiledSelector<Source> {
  readonly select: (
    document: unknown
  ) => Effect.Effect<readonly unknown[], SourcePluginError>;
  readonly sourceSchema: DocumentSourceSchema<Source>;
}

declare const documentSourceSchemaSelectionType: unique symbol;

export interface DocumentSourceSchemaSelection<Source> {
  readonly [documentSourceSchemaSelectionType]: (source: Source) => Source;
}

export type DocumentSourceSchemaCursor<Source> =
  DocumentSourceSchemaSelection<Source> &
    (DocumentSourceCursorFocus<Source> extends object
      ? {
          readonly [Key in DocumentSourceObjectKeys<
            DocumentSourceCursorFocus<Source>
          >]: DocumentSourceSchemaCursor<
            DocumentSourceCursorFocus<Source>[Key]
          >;
        }
      : Record<never, never>);

export interface DocumentSourceItemSelector<Document, Selection> {
  readonly item: (
    document: DocumentSourceSchemaCursor<Document>
  ) => DocumentSourceSchemaSelection<Selection>;
  readonly parent?: never;
}

export interface DocumentSourceSubitemSelector<
  Document,
  ParentSelection,
  Selection,
> {
  readonly item: (
    parent: DocumentSourceSchemaCursor<
      DocumentSourceCursorFocus<ParentSelection>
    >
  ) => DocumentSourceSchemaSelection<Selection>;
  readonly parent: (
    document: DocumentSourceSchemaCursor<Document>
  ) => DocumentSourceSchemaSelection<ParentSelection>;
}

export type DocumentSourceIdentity<Source> = (
  item: Source
) => DocumentSourceIdentityValue;

export type DocumentSourceVersion<Source> =
  | {
      readonly kind: "content-hash";
    }
  | {
      readonly kind: "value";
      readonly value: (item: Source) => DocumentSourceIdentityValue;
    };

export type DocumentSourceLookup<Resource, FetcherCursor> =
  | {
      readonly kind: "scan";
    }
  | {
      readonly kind: "direct";
      readonly read: (
        identity: SourceIdentityInput
      ) => Effect.Effect<
        DocumentSourceDirectLookupResult<Resource, FetcherCursor> | null,
        SourcePluginError
      >;
    };

export interface DocumentSourceBaseOptions<Resource, FetcherCursor, Document> {
  readonly batchSize?: number;
  readonly fetcher: DocumentFetcher<Resource, FetcherCursor>;
  readonly lookup: DocumentSourceLookup<Resource, FetcherCursor>;
  readonly parser: DocumentParser<Resource, Document>;
}

export interface DocumentSourceItemOptions<
  Resource,
  FetcherCursor,
  Document,
  Selection,
> extends DocumentSourceBaseOptions<Resource, FetcherCursor, Document> {
  readonly identity: DocumentSourceIdentity<
    DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
  >;
  readonly selector: DocumentSourceItemSelector<Document, Selection>;
  readonly version: DocumentSourceVersion<
    DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
  >;
}

export interface DocumentSourceSubitemOptions<
  Resource,
  FetcherCursor,
  Document,
  ParentSelection,
  Selection,
> extends DocumentSourceBaseOptions<Resource, FetcherCursor, Document> {
  readonly identity: DocumentSourceIdentity<
    DocumentSourceSelectedSubitem<
      DocumentSourceCursorFocus<ParentSelection>,
      DocumentSourceCursorFocus<Selection>
    >
  >;
  readonly selector: DocumentSourceSubitemSelector<
    Document,
    ParentSelection,
    Selection
  >;
  readonly version: DocumentSourceVersion<
    DocumentSourceSelectedSubitem<
      DocumentSourceCursorFocus<ParentSelection>,
      DocumentSourceCursorFocus<Selection>
    >
  >;
}

interface DocumentSourceCompiledOptions<Resource, FetcherCursor, Source>
  extends DocumentSourceBaseOptions<Resource, FetcherCursor, unknown> {
  readonly identity: DocumentSourceIdentity<Source>;
  readonly selector: DocumentSourceCompiledSelector<Source>;
  readonly version: DocumentSourceVersion<Source>;
}

interface DocumentSourceLoadedItem<Source> {
  readonly documentIndex: number;
  readonly item: SourceItemInput<Source>;
  readonly itemIndex: number;
}

interface DocumentSourceSelectionFrame {
  readonly pathValues: ReadonlyMap<string, unknown>;
  readonly value: unknown;
}

interface DocumentSourceLoadedResource<Source, FetcherCursor> {
  readonly fetcherCursor: FetcherCursor | null;
  readonly fingerprint?: string | undefined;
  readonly items: readonly DocumentSourceLoadedItem<Source>[];
  readonly nextFetcherCursor?: FetcherCursor | undefined;
}

const textEncoder = new TextEncoder();
const documentSourceSchemaCursorState = Symbol(
  "DocumentSourceSchemaCursorState"
);

const documentSourceError = (
  message: string,
  cause?: unknown
): SourcePluginError =>
  new SourcePluginError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const diagnosticFromCause = (cause: unknown): string => {
  if (cause instanceof SourcePluginError) {
    const nestedDiagnostic =
      typeof cause.cause === "object" &&
      cause.cause !== null &&
      "diagnostic" in cause.cause
        ? String(cause.cause.diagnostic)
        : undefined;

    return nestedDiagnostic === undefined
      ? cause.message
      : `${cause.message}: ${nestedDiagnostic}`;
  }

  return String(cause);
};

const hexFromBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = (
  bytes: Uint8Array
): Effect.Effect<string, SourcePluginError> =>
  Effect.tryPromise({
    try: async () => {
      const webCrypto = globalThis.crypto;

      if (webCrypto?.subtle !== undefined) {
        const digestInput = new Uint8Array(bytes).buffer;
        const digest = await webCrypto.subtle.digest("SHA-256", digestInput);
        return hexFromBytes(new Uint8Array(digest));
      }

      throw new Error("Web Crypto SHA-256 support is required");
    },
    catch: (cause) =>
      documentSourceError("Unable to hash document source item", cause),
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const arrayElementSchema = (
  value: DocumentSourceSchema
): DocumentSourceSchema | null => {
  if (!SchemaAST.isArrays(value.ast)) {
    return null;
  }

  const arrayAst = value.ast as typeof value.ast & {
    readonly rest: readonly DocumentSourceSchema["ast"][];
  };
  const elementAst = arrayAst.rest[0];

  return elementAst === undefined
    ? null
    : (Schema.make(elementAst) as DocumentSourceSchema);
};

const objectFieldSchema = (
  value: DocumentSourceSchema,
  field: string
): DocumentSourceSchema | null => {
  if (!SchemaAST.isObjects(value.ast)) {
    return null;
  }

  const fieldAst = value.ast.propertySignatures.find(
    (propertySignature) => propertySignature.name === field
  )?.type;

  return fieldAst === undefined
    ? null
    : (Schema.make(fieldAst) as DocumentSourceSchema);
};

const pathKey = (segments: readonly DocumentSourcePathSegment[]): string =>
  segments.map((segment) => `${segment.key}:${segment.kind}`).join("/");

const makeSchemaCursor = <Source>(
  schema: DocumentSourceSchema<Source>,
  path: readonly DocumentSourcePathSegment[]
): DocumentSourceSchemaCursor<Source> =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === documentSourceSchemaCursorState) {
          return {
            path,
            schema,
          } satisfies DocumentSourceSchemaCursorState<Source>;
        }

        if (typeof property !== "string") {
          return undefined;
        }

        if (!SchemaAST.isObjects(schema.ast)) {
          throw new Error(
            `Document source selector field cannot be selected from a non-object schema: ${property}`
          );
        }

        const fieldSchema = objectFieldSchema(schema, property);

        if (fieldSchema === null) {
          throw new Error(
            `Document source selector field was not found: ${property}`
          );
        }

        const elementSchema = arrayElementSchema(fieldSchema);

        if (elementSchema !== null) {
          return makeSchemaCursor(elementSchema, [
            ...path,
            { key: property, kind: "array" },
          ]);
        }

        return makeSchemaCursor(fieldSchema, [
          ...path,
          { key: property, kind: "property" },
        ]);
      },
    }
  ) as DocumentSourceSchemaCursor<Source>;

const schemaCursorState = <Source>(
  cursor: unknown
): DocumentSourceSchemaCursorState<DocumentSourceCursorFocus<Source>> => {
  const state = (
    cursor as {
      readonly [documentSourceSchemaCursorState]?:
        | DocumentSourceSchemaCursorState<DocumentSourceCursorFocus<Source>>
        | undefined;
    }
  )[documentSourceSchemaCursorState];

  if (state === undefined) {
    throw new Error("Document source selector must return a schema cursor");
  }

  return state;
};

const assertArraySelection = (
  state: DocumentSourceSchemaCursorState<unknown>,
  label: string
): void => {
  if (state.path.at(-1)?.kind !== "array") {
    throw new Error(`${label} must select an array field`);
  }
};

const isPathPrefix = (
  prefix: readonly DocumentSourcePathSegment[],
  path: readonly DocumentSourcePathSegment[]
): boolean =>
  prefix.length <= path.length &&
  prefix.every(
    (segment, index) =>
      path[index]?.key === segment.key && path[index]?.kind === segment.kind
  );

const selectProjectionPath = (
  document: unknown,
  segments: readonly DocumentSourcePathSegment[]
): Effect.Effect<readonly DocumentSourceSelectionFrame[], SourcePluginError> =>
  Effect.gen(function* () {
    let frames: readonly DocumentSourceSelectionFrame[] = [
      {
        pathValues: new Map([["", document]]),
        value: document,
      },
    ];
    let currentPath: readonly DocumentSourcePathSegment[] = [];

    for (const segment of segments) {
      currentPath = [...currentPath, segment];
      const currentPathKey = pathKey(currentPath);
      const nextFrames: DocumentSourceSelectionFrame[] = [];

      for (const frame of frames) {
        if (!isRecord(frame.value)) {
          return yield* documentSourceError(
            "Document source selector path was not found",
            {
              path: currentPath,
              segment,
            }
          );
        }

        const selected = frame.value[segment.key];

        if (segment.kind === "array") {
          if (!Array.isArray(selected)) {
            return yield* documentSourceError(
              "Document source selector path must resolve to array",
              {
                path: currentPath,
                segment,
              }
            );
          }

          for (const element of selected) {
            nextFrames.push({
              pathValues: new Map(frame.pathValues).set(
                currentPathKey,
                element
              ),
              value: element,
            });
          }
        } else {
          nextFrames.push({
            pathValues: new Map(frame.pathValues).set(currentPathKey, selected),
            value: selected,
          });
        }
      }

      frames = nextFrames;
    }

    return frames;
  });

const hasParentSelector = <Document>(
  selector:
    | DocumentSourceItemSelector<Document, unknown>
    | DocumentSourceSubitemSelector<Document, unknown, unknown>
): selector is DocumentSourceSubitemSelector<Document, unknown, unknown> =>
  "parent" in selector;

const parentStateCursor = <Source>(
  state: DocumentSourceSchemaCursorState<Source>
): DocumentSourceSchemaCursor<Source> =>
  makeSchemaCursor(state.schema, state.path);

const compileItemSelector = <Document, Selection>(
  documentSchema: DocumentSourceSchema<Document>,
  selector: DocumentSourceItemSelector<Document, Selection>
): DocumentSourceCompiledSelector<
  DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
> => {
  const rootCursor = makeSchemaCursor(documentSchema, []);
  const itemState = schemaCursorState<DocumentSourceCursorFocus<Selection>>(
    selector.item(rootCursor)
  );
  assertArraySelection(itemState, "Document source item selector");
  const sourceSchema = Schema.Struct({
    item: itemState.schema,
  }) as unknown as DocumentSourceSchema<
    DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
  >;

  return {
    select: (document) =>
      selectProjectionPath(document, itemState.path).pipe(
        Effect.map((frames) => frames.map((frame) => ({ item: frame.value })))
      ),
    sourceSchema,
  };
};

const compileSubitemSelector = <Document, ParentSelection, Selection>(
  documentSchema: DocumentSourceSchema<Document>,
  selector: DocumentSourceSubitemSelector<Document, ParentSelection, Selection>
): DocumentSourceCompiledSelector<
  DocumentSourceSelectedSubitem<
    DocumentSourceCursorFocus<ParentSelection>,
    DocumentSourceCursorFocus<Selection>
  >
> => {
  const rootCursor = makeSchemaCursor(documentSchema, []);
  const parentState = schemaCursorState<
    DocumentSourceCursorFocus<ParentSelection>
  >(selector.parent(rootCursor));
  assertArraySelection(parentState, "Document source parent selector");
  const itemState = schemaCursorState<DocumentSourceCursorFocus<Selection>>(
    selector.item(
      parentStateCursor(parentState) as DocumentSourceSchemaCursor<
        DocumentSourceCursorFocus<ParentSelection>
      >
    )
  );
  assertArraySelection(itemState, "Document source item selector");

  if (!isPathPrefix(parentState.path, itemState.path)) {
    throw new Error(
      "Document source item selector must be nested under parent selector"
    );
  }

  const parentPathKey = pathKey(parentState.path);
  const sourceSchema = Schema.Struct({
    item: itemState.schema,
    parent: parentState.schema,
  }) as unknown as DocumentSourceSchema<
    DocumentSourceSelectedSubitem<
      DocumentSourceCursorFocus<ParentSelection>,
      DocumentSourceCursorFocus<Selection>
    >
  >;

  return {
    select: (document) =>
      selectProjectionPath(document, itemState.path).pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(frames, (frame, itemIndex) => {
            if (!frame.pathValues.has(parentPathKey)) {
              return Effect.fail(
                documentSourceError(
                  "Document source parent selection was not found for item",
                  {
                    itemIndex,
                    parentPath: parentState.path,
                  }
                )
              );
            }

            return Effect.succeed({
              item: frame.value,
              parent: frame.pathValues.get(parentPathKey),
            });
          })
        )
      ),
    sourceSchema,
  };
};

const compileSelector = <Document>(
  documentSchema: DocumentSourceSchema<Document>,
  selector:
    | DocumentSourceItemSelector<Document, unknown>
    | DocumentSourceSubitemSelector<Document, unknown, unknown>
): DocumentSourceCompiledSelector<unknown> =>
  hasParentSelector(selector)
    ? compileSubitemSelector(documentSchema, selector)
    : compileItemSelector(documentSchema, selector);

const makeCursorSchema = <FetcherCursor>(
  fetcherCursorSchema: Schema.Codec<FetcherCursor, unknown, never, never>
): Schema.Codec<DocumentSourceCursor<FetcherCursor>, unknown, never, never> =>
  Schema.Struct({
    fetcherCursor: Schema.NullOr(fetcherCursorSchema),
    nextDocumentIndex: Schema.Int,
    nextItemIndex: Schema.Int,
    resourceFingerprint: Schema.optional(Schema.String),
  }) as unknown as Schema.Codec<
    DocumentSourceCursor<FetcherCursor>,
    unknown,
    never,
    never
  >;

const stringifyIdentityValue = (
  value: DocumentSourceIdentityScalar,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return yield* documentSourceError(
        `Document source ${label} value must be a scalar value`,
        { itemIndex, value }
      );
    }

    const stringValue = String(value).trim();

    if (stringValue.length === 0) {
      return yield* documentSourceError(
        `Document source ${label} value must not be empty`,
        { itemIndex }
      );
    }

    return stringValue;
  });

const isIdentityValueArray = (
  value: DocumentSourceIdentityValue
): value is readonly DocumentSourceIdentityScalar[] => Array.isArray(value);

const normalizeIdentityValue = (
  value: DocumentSourceIdentityValue,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    if (isIdentityValueArray(value)) {
      if (value.length === 0) {
        return yield* documentSourceError(
          `Document source ${label} value must include at least one scalar value`,
          { itemIndex }
        );
      }

      const values = yield* Effect.forEach(value, (entry) =>
        stringifyIdentityValue(entry, itemIndex, label)
      );

      return JSON.stringify(values);
    }

    return yield* stringifyIdentityValue(value, itemIndex, label);
  });

const buildIdentity = <Source>(
  item: Source,
  identity: DocumentSourceIdentity<Source>,
  itemIndex: number
): Effect.Effect<SourceIdentityInput, SourcePluginError> =>
  Effect.try({
    try: () => identity(item),
    catch: (cause) =>
      documentSourceError("Unable to build document source identity", {
        cause,
        itemIndex,
      }),
  }).pipe(
    Effect.flatMap((identityValue) =>
      normalizeIdentityValue(identityValue, itemIndex, "identity")
    )
  );

const encodeSourceItemJson = <Source>(
  item: Source,
  sourceSchema: Schema.Codec<Source, unknown, never, never>,
  itemIndex: number
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    const encodedItem = yield* Schema.encodeEffect(sourceSchema)(item).pipe(
      Effect.mapError((cause) =>
        documentSourceError(
          "Unable to encode document source item for content hash",
          {
            cause,
            itemIndex,
          }
        )
      )
    );

    return yield* Effect.try({
      try: () => {
        const material = JSON.stringify(encodedItem);

        if (material === undefined) {
          throw new TypeError(
            "Schema-encoded document source item could not be serialized"
          );
        }

        return material;
      },
      catch: (cause) =>
        documentSourceError(
          "Unable to serialize document source item for content hash",
          {
            cause,
            itemIndex,
          }
        ),
    });
  });

const buildVersion = <Source>(
  item: Source,
  version: DocumentSourceVersion<Source>,
  sourceSchema: Schema.Codec<Source, unknown, never, never>,
  itemIndex: number
): Effect.Effect<SourceVersionInput, SourcePluginError> =>
  Effect.gen(function* () {
    switch (version.kind) {
      case "content-hash": {
        const material = yield* encodeSourceItemJson(
          item,
          sourceSchema,
          itemIndex
        );

        return yield* sha256Hex(textEncoder.encode(material));
      }
      case "value": {
        const versionValue = yield* Effect.try({
          try: () => version.value(item),
          catch: (cause) =>
            documentSourceError("Unable to build document source version", {
              cause,
              itemIndex,
            }),
        });

        return yield* normalizeIdentityValue(
          versionValue,
          itemIndex,
          "version"
        );
      }
      default: {
        const unhandledVersion: never = version;
        throw new Error(
          `Unhandled document source version configuration: ${unhandledVersion}`
        );
      }
    }
  });

const buildSelectedSourceItem = <Source>(
  rawItem: unknown,
  documentIndex: number,
  itemIndex: number,
  options: DocumentSourceCompiledOptions<unknown, unknown, Source>
): Effect.Effect<DocumentSourceLoadedItem<Source>, SourcePluginError> =>
  Effect.gen(function* () {
    const item = rawItem as Source;
    const identity = yield* buildIdentity(item, options.identity, itemIndex);
    const version = yield* buildVersion(
      item,
      options.version,
      options.selector.sourceSchema,
      itemIndex
    );

    return {
      documentIndex,
      item: {
        identity,
        item,
        version,
      },
      itemIndex,
    };
  });

const ensureUniqueIdentities = <Source>(
  items: readonly DocumentSourceLoadedItem<Source>[]
): Effect.Effect<void, SourcePluginError> =>
  Effect.gen(function* () {
    const identityIndexes = new Map<string, number>();

    for (const [index, loadedItem] of items.entries()) {
      const existingIndex = identityIndexes.get(loadedItem.item.identity);

      if (existingIndex !== undefined) {
        return yield* documentSourceError(
          "Duplicate document source identity",
          {
            duplicateItemIndex: index,
            firstItemIndex: existingIndex,
            sourceIdentity: loadedItem.item.identity,
          }
        );
      }

      identityIndexes.set(loadedItem.item.identity, index);
    }
  });

const parseResourceDocuments = <Resource, Document, FetcherCursor>(
  parser: DocumentParser<Resource, Document>,
  resourceResult: DocumentFetchResult<Resource, FetcherCursor>,
  fetcherCursor: FetcherCursor | null,
  context: Record<string, unknown> = {}
): Effect.Effect<readonly Document[], SourcePluginError> =>
  parser.parse(resourceResult.resource).pipe(
    Effect.mapError((cause) =>
      documentSourceError("Unable to parse document source resource", {
        cause,
        diagnostic: diagnosticFromCause(cause),
        fetcherCursor,
        ...context,
        parser: parser.name,
        resourceFingerprint: resourceResult.fingerprint,
      })
    )
  );

const loadResourceResult = <Resource, FetcherCursor, Source>(
  options: DocumentSourceCompiledOptions<Resource, FetcherCursor, Source>,
  fetcherCursor: FetcherCursor | null,
  resourceResult: DocumentFetchResult<Resource, FetcherCursor>,
  context?: Record<string, unknown>
): Effect.Effect<
  DocumentSourceLoadedResource<Source, FetcherCursor>,
  SourcePluginError
> =>
  Effect.gen(function* () {
    const documents = yield* parseResourceDocuments(
      options.parser,
      resourceResult,
      fetcherCursor,
      context
    );
    const loadedItems: DocumentSourceLoadedItem<Source>[] = [];

    for (const [documentIndex, document] of documents.entries()) {
      const selectedItems = yield* options.selector.select(document);
      const decodedItems = yield* Effect.forEach(
        selectedItems,
        (item, itemIndex) =>
          buildSelectedSourceItem(
            item,
            documentIndex,
            itemIndex,
            options as DocumentSourceCompiledOptions<unknown, unknown, Source>
          )
      );
      loadedItems.push(...decodedItems);
    }

    yield* ensureUniqueIdentities(loadedItems);

    return {
      fetcherCursor,
      fingerprint: resourceResult.fingerprint,
      items: loadedItems,
      nextFetcherCursor: resourceResult.nextCursor,
    };
  });

const loadResource = <Resource, FetcherCursor, Source>(
  options: DocumentSourceCompiledOptions<Resource, FetcherCursor, Source>,
  fetcherCursor: FetcherCursor | null
): Effect.Effect<
  DocumentSourceLoadedResource<Source, FetcherCursor>,
  SourcePluginError
> =>
  Effect.gen(function* () {
    const resourceResult = yield* options.fetcher.read(fetcherCursor);

    return yield* loadResourceResult(options, fetcherCursor, resourceResult);
  });

const configuredBatchSize = (
  batchSize: number | undefined
): Effect.Effect<number | null, SourcePluginError> => {
  if (batchSize === undefined) {
    return Effect.succeed(null);
  }

  return Number.isInteger(batchSize) && batchSize > 0
    ? Effect.succeed(batchSize)
    : Effect.fail(
        documentSourceError(
          "Document source batchSize must be a positive integer",
          { batchSize }
        )
      );
};

const startIndexForCursor = <Source, FetcherCursor>(
  resource: DocumentSourceLoadedResource<Source, FetcherCursor>,
  cursor: DocumentSourceCursor<FetcherCursor> | null
): number => {
  if (
    cursor === null ||
    (cursor.resourceFingerprint !== undefined &&
      resource.fingerprint !== undefined &&
      cursor.resourceFingerprint !== resource.fingerprint)
  ) {
    return 0;
  }

  return resource.items.findIndex(
    (item) =>
      item.documentIndex > cursor.nextDocumentIndex ||
      (item.documentIndex === cursor.nextDocumentIndex &&
        item.itemIndex >= cursor.nextItemIndex)
  );
};

const nextResourceCursor = <FetcherCursor>(
  fetcherCursor: FetcherCursor | undefined
): DocumentSourceCursor<FetcherCursor> | undefined =>
  fetcherCursor === undefined
    ? undefined
    : {
        fetcherCursor,
        nextDocumentIndex: 0,
        nextItemIndex: 0,
      };

const makeImplementation = <Resource, FetcherCursor, Source>(
  options: DocumentSourceCompiledOptions<Resource, FetcherCursor, Source>
): SourcePluginImplementation<Source, DocumentSourceCursor<FetcherCursor>> => {
  const read = Effect.fn("DocumentSource.read")(function* (
    cursor: DocumentSourceCursor<FetcherCursor> | null
  ) {
    const windowSize = yield* configuredBatchSize(options.batchSize);
    const fetcherCursor = cursor?.fetcherCursor ?? null;
    const resource = yield* loadResource(options, fetcherCursor);
    const startIndex = startIndexForCursor(resource, cursor);

    if (startIndex === -1) {
      return {
        items: [],
        nextCursor: nextResourceCursor(resource.nextFetcherCursor),
      };
    }

    const effectiveWindowSize = windowSize ?? resource.items.length;
    const endIndex = startIndex + effectiveWindowSize;
    const window = resource.items.slice(startIndex, endIndex);
    const nextItem = resource.items[endIndex];

    return {
      items: window.map((loadedItem) => loadedItem.item),
      ...(nextItem === undefined
        ? {
            nextCursor: nextResourceCursor(resource.nextFetcherCursor),
          }
        : {
            nextCursor: {
              fetcherCursor,
              nextDocumentIndex: nextItem.documentIndex,
              nextItemIndex: nextItem.itemIndex,
              resourceFingerprint: resource.fingerprint,
            } satisfies DocumentSourceCursor<FetcherCursor>,
          }),
    };
  });

  const readByIdentity = Effect.fn("DocumentSource.readByIdentity")(function* (
    identity: SourceIdentityInput
  ) {
    if (options.lookup.kind === "direct") {
      const resourceResult = yield* options.lookup.read(identity);

      if (resourceResult === null) {
        return null;
      }

      const resource = yield* loadResourceResult(
        options,
        null,
        resourceResult,
        {
          sourceIdentity: identity,
        }
      );
      const matches = resource.items.filter(
        (loadedItem) => loadedItem.item.identity === identity
      );

      if (matches.length > 1) {
        return yield* documentSourceError(
          "Duplicate document source identity",
          {
            sourceIdentity: identity,
          }
        );
      }

      return matches[0]?.item ?? null;
    }

    let fetcherCursor: FetcherCursor | null = null;
    let found: SourceItemInput<Source> | null = null;

    while (true) {
      const resource: DocumentSourceLoadedResource<Source, FetcherCursor> =
        yield* loadResource(options, fetcherCursor);
      const matches: readonly DocumentSourceLoadedItem<Source>[] =
        resource.items.filter(
          (loadedItem) => loadedItem.item.identity === identity
        );

      if (matches.length > 1 || (matches.length === 1 && found !== null)) {
        return yield* documentSourceError(
          "Duplicate document source identity",
          {
            sourceIdentity: identity,
          }
        );
      }

      if (matches.length === 1) {
        found = matches[0]?.item ?? null;
      }

      if (resource.nextFetcherCursor === undefined) {
        return found;
      }

      fetcherCursor = resource.nextFetcherCursor;
    }
  });

  return {
    lookupStrategy: options.lookup.kind,
    read,
    readByIdentity,
  };
};

function makeSource<Resource, FetcherCursor, Document, Selection>(
  options: DocumentSourceBaseOptions<Resource, FetcherCursor, Document> & {
    readonly identity: DocumentSourceIdentity<
      DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
    >;
    readonly selector: DocumentSourceItemSelector<Document, Selection>;
    readonly version: DocumentSourceVersion<
      DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
    >;
  }
): ConfiguredSourcePlugin<
  DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>,
  DocumentSourceCursor<FetcherCursor>
>;
function makeSource<
  Resource,
  FetcherCursor,
  Document,
  ParentSelection,
  Selection,
>(
  options: DocumentSourceBaseOptions<Resource, FetcherCursor, Document> & {
    readonly identity: DocumentSourceIdentity<
      DocumentSourceSelectedSubitem<
        DocumentSourceCursorFocus<ParentSelection>,
        DocumentSourceCursorFocus<Selection>
      >
    >;
    readonly selector: DocumentSourceSubitemSelector<
      Document,
      ParentSelection,
      Selection
    >;
    readonly version: DocumentSourceVersion<
      DocumentSourceSelectedSubitem<
        DocumentSourceCursorFocus<ParentSelection>,
        DocumentSourceCursorFocus<Selection>
      >
    >;
  }
): ConfiguredSourcePlugin<
  DocumentSourceSelectedSubitem<
    DocumentSourceCursorFocus<ParentSelection>,
    DocumentSourceCursorFocus<Selection>
  >,
  DocumentSourceCursor<FetcherCursor>
>;
function makeSource<Resource, FetcherCursor, Document, Source>(
  options:
    | DocumentSourceItemOptions<Resource, FetcherCursor, Document, unknown>
    | DocumentSourceSubitemOptions<
        Resource,
        FetcherCursor,
        Document,
        unknown,
        unknown
      >
): ConfiguredSourcePlugin<Source, DocumentSourceCursor<FetcherCursor>> {
  const compiledSelector = compileSelector(
    options.parser.documentSchema,
    options.selector
  ) as DocumentSourceCompiledSelector<Source>;
  const compiledOptions = {
    ...options,
    selector: compiledSelector,
  } as DocumentSourceCompiledOptions<Resource, FetcherCursor, Source>;
  const cursorSchema = makeCursorSchema(options.fetcher.cursorSchema);
  const configured = defineSourcePlugin({
    cursorSchema,
    make: () => makeImplementation(compiledOptions),
    sourceSchema: compiledSelector.sourceSchema,
  });

  return {
    layer: configured.layer,
    sourceSchema: compiledSelector.sourceSchema,
  } as ConfiguredSourcePlugin<Source, DocumentSourceCursor<FetcherCursor>>;
}

export const DocumentSourcePlugin = {
  make: makeSource,
} as const;
