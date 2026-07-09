import { Effect, Schema, SchemaAST } from "effect";
import { type ConfiguredSource, Source } from "../../domain/definition.ts";
import { SourceError } from "../../domain/errors.ts";
import type {
  SourceIdentityContractIdInput,
  SourceIdentityDefinition,
  SourceIdentitySchema,
  SourceIdentitySnapshotKey,
  SourceIdentityTarget,
  SourceVersionInput,
} from "../../domain/ids.ts";
import { SourceIdentity } from "../../domain/ids.ts";
import {
  makeSourceIdentityContractFingerprint,
  makeSourceVersionContractFingerprint,
  SourceVersionContractId,
  type SourceVersionContractIdInput,
} from "../../domain/migration-contract.ts";
import {
  encodeSourceIdentityKey,
  type SourceItemInput,
} from "../../domain/source.ts";
import type { SourceRuntimeImplementation } from "../../services/source.ts";
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

type DocumentSourceSelectedSchema<Decoded> = Schema.Codec<
  Decoded,
  Decoded,
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

interface DocumentSourceSchemaCursorState<Payload> {
  readonly path: readonly DocumentSourcePathSegment[];
  readonly schema: DocumentSourceSchema<Payload>;
}

export interface DocumentSourceSelectedItem<Item> {
  readonly item: Item;
}

export interface DocumentSourceSelectedSubitem<Parent, Item> {
  readonly item: Item;
  readonly parent: Parent;
}

interface DocumentSourceCompiledSelector<Payload> {
  readonly select: (
    document: unknown
  ) => Effect.Effect<readonly unknown[], SourceError>;
  readonly sourceSchema: DocumentSourceSelectedSchema<Payload>;
}

declare const documentSourceSchemaSelectionType: unique symbol;

export interface DocumentSourceSchemaSelection<Payload> {
  readonly [documentSourceSchemaSelectionType]: (source: Payload) => Payload;
}

export type DocumentSourceSchemaCursor<Payload> =
  DocumentSourceSchemaSelection<Payload> &
    (DocumentSourceCursorFocus<Payload> extends object
      ? {
          readonly [Key in DocumentSourceObjectKeys<
            DocumentSourceCursorFocus<Payload>
          >]: DocumentSourceSchemaCursor<
            DocumentSourceCursorFocus<Payload>[Key]
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

export interface DocumentSourceIdentity<
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly id: SourceIdentityContractIdInput;
  readonly key: (item: Payload) => IdentityKey;
  readonly schema: SourceIdentitySchema<IdentityKey>;
}

export type DocumentSourceVersion<Payload> =
  | {
      readonly kind: "content-hash";
    }
  | {
      readonly id: SourceVersionContractIdInput;
      readonly kind: "value";
      readonly value: (item: Payload) => DocumentSourceIdentityValue;
    };

export type DocumentSourceLookup<
  Resource,
  FetcherCursor,
  IdentityKey extends SourceIdentitySnapshotKey,
> =
  | {
      readonly kind: "scan";
    }
  | {
      readonly kind: "direct";
      readonly read: (
        identity: SourceIdentityTarget<IdentityKey>
      ) => Effect.Effect<
        DocumentSourceDirectLookupResult<Resource, FetcherCursor> | null,
        SourceError
      >;
    };

export interface DocumentSourceTotalContext<Resource, FetcherCursor, Document> {
  readonly countDocuments: (
    documents: readonly Document[]
  ) => Effect.Effect<number, SourceError>;
  readonly countResource: (
    resourceResult: DocumentFetchResult<Resource, FetcherCursor>
  ) => Effect.Effect<number, SourceError>;
}

export type DocumentSourceTotalCallback<Resource, FetcherCursor, Document> = (
  context: DocumentSourceTotalContext<Resource, FetcherCursor, Document>
) => Effect.Effect<number, SourceError>;

export interface DocumentSourceBaseOptions<
  Resource,
  FetcherCursor,
  Document,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly batchSize?: number;
  readonly countTotal?: DocumentSourceTotalCallback<
    Resource,
    FetcherCursor,
    Document
  >;
  readonly fetcher: DocumentFetcher<Resource, FetcherCursor>;
  readonly lookup: DocumentSourceLookup<Resource, FetcherCursor, IdentityKey>;
  readonly parser: DocumentParser<Resource, Document>;
}

export interface DocumentSourceItemOptions<
  Resource,
  FetcherCursor,
  Document,
  Selection,
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends DocumentSourceBaseOptions<
    Resource,
    FetcherCursor,
    Document,
    IdentityKey
  > {
  readonly identity: DocumentSourceIdentity<
    DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>,
    IdentityKey
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
  IdentityKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends DocumentSourceBaseOptions<
    Resource,
    FetcherCursor,
    Document,
    IdentityKey
  > {
  readonly identity: DocumentSourceIdentity<
    DocumentSourceSelectedSubitem<
      DocumentSourceCursorFocus<ParentSelection>,
      DocumentSourceCursorFocus<Selection>
    >,
    IdentityKey
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

interface DocumentSourceCompiledOptions<
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
> extends DocumentSourceBaseOptions<
    Resource,
    FetcherCursor,
    unknown,
    IdentityKey
  > {
  readonly identity: DocumentSourceIdentity<Payload, IdentityKey>;
  readonly selector: DocumentSourceCompiledSelector<Payload>;
  readonly version: DocumentSourceVersion<Payload>;
}

interface DocumentSourceLoadedItem<
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly documentIndex: number;
  readonly item: SourceItemInput<Payload, IdentityKey>;
  readonly itemIndex: number;
}

interface DocumentSourceSelectionFrame {
  readonly pathValues: ReadonlyMap<string, unknown>;
  readonly value: unknown;
}

interface DocumentSourceLoadedResource<
  Payload,
  FetcherCursor,
  IdentityKey extends SourceIdentitySnapshotKey,
> {
  readonly fetcherCursor: FetcherCursor | null;
  readonly fingerprint?: string | undefined;
  readonly items: readonly DocumentSourceLoadedItem<Payload, IdentityKey>[];
  readonly nextFetcherCursor?: FetcherCursor | undefined;
}

const textEncoder = new TextEncoder();
const documentSourceSchemaCursorState = Symbol(
  "DocumentSourceSchemaCursorState"
);

const documentSourceError = (message: string, cause?: unknown): SourceError =>
  new SourceError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const diagnosticFromCause = (cause: unknown): string => {
  if (Schema.is(SourceError)(cause)) {
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

const sha256Hex = (bytes: Uint8Array): Effect.Effect<string, SourceError> =>
  Effect.tryPromise({
    try: () => {
      const webCrypto = globalThis.crypto;

      if (webCrypto?.subtle !== undefined) {
        const digestInput = new Uint8Array(bytes).buffer;
        return webCrypto.subtle
          .digest("SHA-256", digestInput)
          .then((digest) => hexFromBytes(new Uint8Array(digest)));
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

const makeSchemaCursor = <Payload>(
  schema: DocumentSourceSchema<Payload>,
  path: readonly DocumentSourcePathSegment[]
): DocumentSourceSchemaCursor<Payload> =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === documentSourceSchemaCursorState) {
          return {
            path,
            schema,
          } satisfies DocumentSourceSchemaCursorState<Payload>;
        }

        if (typeof property !== "string") {
          return;
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
  ) as DocumentSourceSchemaCursor<Payload>;

const schemaCursorState = <Payload>(
  cursor: unknown
): DocumentSourceSchemaCursorState<DocumentSourceCursorFocus<Payload>> => {
  const state = (
    cursor as {
      readonly [documentSourceSchemaCursorState]?:
        | DocumentSourceSchemaCursorState<DocumentSourceCursorFocus<Payload>>
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
): Effect.Effect<readonly DocumentSourceSelectionFrame[], SourceError> =>
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

const parentStateCursor = <Payload>(
  state: DocumentSourceSchemaCursorState<Payload>
): DocumentSourceSchemaCursor<Payload> =>
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
  }) as unknown as DocumentSourceSelectedSchema<
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
  }) as unknown as DocumentSourceSelectedSchema<
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
): Schema.Codec<DocumentSourceCursor<FetcherCursor>, unknown, never, never> => {
  const schema: Schema.Codec<
    DocumentSourceCursor<FetcherCursor>,
    unknown,
    never,
    never
  > = Schema.Struct({
    fetcherCursor: Schema.NullOr(fetcherCursorSchema),
    nextDocumentIndex: Schema.Int,
    nextItemIndex: Schema.Int,
    resourceFingerprint: Schema.optional(Schema.String),
  });

  return schema;
};

const stringifyIdentityValue = (
  value: DocumentSourceIdentityScalar,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourceError> =>
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
): Effect.Effect<string, SourceError> =>
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

      return yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
        values
      ).pipe(
        Effect.mapError((cause) =>
          documentSourceError(
            `Unable to serialize document source ${label} value`,
            { cause, itemIndex }
          )
        )
      );
    }

    return yield* stringifyIdentityValue(value, itemIndex, label);
  });

const makeDocumentSourceIdentityDefinition = <
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  identity: DocumentSourceIdentity<Payload, IdentityKey>
): SourceIdentityDefinition<IdentityKey> =>
  SourceIdentity.make({
    id: identity.id,
    schema: identity.schema,
  });

const makeDocumentSourceIdentityContractFingerprint = <
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  identityDefinition: SourceIdentityDefinition<IdentityKey>
) =>
  makeSourceIdentityContractFingerprint({
    identity: identityDefinition.fingerprint,
    source: "document@v1",
  });

const makeDocumentSourceVersionContractFingerprint = <Payload>(
  version: DocumentSourceVersion<Payload>
) =>
  makeSourceVersionContractFingerprint({
    source: "document@v1",
    version:
      version.kind === "value"
        ? {
            id: SourceVersionContractId.make(version.id),
            kind: version.kind,
          }
        : {
            kind: version.kind,
          },
  });

const buildIdentity = <Payload, IdentityKey extends SourceIdentitySnapshotKey>(
  item: Payload,
  identity: DocumentSourceIdentity<Payload, IdentityKey>,
  itemIndex: number
): Effect.Effect<IdentityKey, SourceError> =>
  Effect.try({
    try: () => identity.key(item),
    catch: (cause) =>
      documentSourceError("Unable to build document source identity", {
        cause,
        itemIndex,
      }),
  });

const encodeSourceItemJson = <Payload>(
  item: Payload,
  sourceSchema: DocumentSourceSelectedSchema<Payload>,
  itemIndex: number
): Effect.Effect<string, SourceError> =>
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

    return yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
      encodedItem
    ).pipe(
      Effect.mapError((cause) =>
        documentSourceError(
          "Unable to serialize document source item for content hash",
          {
            cause,
            itemIndex,
          }
        )
      )
    );
  });

const buildVersion = <Payload>(
  item: Payload,
  version: DocumentSourceVersion<Payload>,
  sourceSchema: DocumentSourceSelectedSchema<Payload>,
  itemIndex: number
): Effect.Effect<SourceVersionInput, SourceError> =>
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

const buildSelectedSourceItem = <
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  rawItem: unknown,
  documentIndex: number,
  itemIndex: number,
  options: DocumentSourceCompiledOptions<unknown, unknown, Payload, IdentityKey>
): Effect.Effect<DocumentSourceLoadedItem<Payload, IdentityKey>, SourceError> =>
  Effect.gen(function* () {
    const item = rawItem as Payload;
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
        identityKey: identity,
        item,
        version,
      },
      itemIndex,
    };
  });

const ensureUniqueIdentities = <
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  identityDefinition: SourceIdentityDefinition<IdentityKey>,
  items: readonly DocumentSourceLoadedItem<Payload, IdentityKey>[]
): Effect.Effect<void, SourceError> =>
  Effect.gen(function* () {
    const identityIndexes = new Map<string, number>();

    for (const [index, loadedItem] of items.entries()) {
      const encodedIdentity = yield* encodeSourceIdentityKey(
        identityDefinition,
        loadedItem.item.identityKey
      );
      const existingIndex = identityIndexes.get(encodedIdentity);

      if (existingIndex !== undefined) {
        return yield* documentSourceError(
          "Duplicate document source identity",
          {
            duplicateItemIndex: index,
            firstItemIndex: existingIndex,
            sourceIdentity: encodedIdentity,
          }
        );
      }

      identityIndexes.set(encodedIdentity, index);
    }
  });

const matchingLoadedItems = <
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  identityDefinition: SourceIdentityDefinition<IdentityKey>,
  items: readonly DocumentSourceLoadedItem<Payload, IdentityKey>[],
  identity: SourceIdentity<IdentityKey>
): Effect.Effect<
  readonly DocumentSourceLoadedItem<Payload, IdentityKey>[],
  SourceError
> =>
  Effect.gen(function* () {
    const matches: DocumentSourceLoadedItem<Payload, IdentityKey>[] = [];

    for (const loadedItem of items) {
      const encodedIdentity = yield* encodeSourceIdentityKey(
        identityDefinition,
        loadedItem.item.identityKey
      );

      if (encodedIdentity === identity.encoded) {
        matches.push(loadedItem);
      }
    }

    return matches;
  });

const parseResourceDocuments = <Resource, Document, FetcherCursor>(
  parser: DocumentParser<Resource, Document>,
  resourceResult: DocumentFetchResult<Resource, FetcherCursor>,
  fetcherCursor: FetcherCursor | null,
  context: Record<string, unknown> = {}
): Effect.Effect<readonly Document[], SourceError> =>
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

const loadResourceResult = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >,
  fetcherCursor: FetcherCursor | null,
  resourceResult: DocumentFetchResult<Resource, FetcherCursor>,
  context?: Record<string, unknown>
): Effect.Effect<
  DocumentSourceLoadedResource<Payload, FetcherCursor, IdentityKey>,
  SourceError
> =>
  Effect.gen(function* () {
    const identityDefinition = makeDocumentSourceIdentityDefinition(
      options.identity
    );
    const documents = yield* parseResourceDocuments(
      options.parser,
      resourceResult,
      fetcherCursor,
      context
    );
    const loadedItems: DocumentSourceLoadedItem<Payload, IdentityKey>[] = [];

    for (const [documentIndex, document] of documents.entries()) {
      const selectedItems = yield* options.selector.select(document);
      const decodedItems = yield* Effect.forEach(
        selectedItems,
        (item, itemIndex) =>
          buildSelectedSourceItem(
            item,
            documentIndex,
            itemIndex,
            options as DocumentSourceCompiledOptions<
              unknown,
              unknown,
              Payload,
              IdentityKey
            >
          )
      );
      loadedItems.push(...decodedItems);
    }

    yield* ensureUniqueIdentities(identityDefinition, loadedItems);

    return {
      fetcherCursor,
      fingerprint: resourceResult.fingerprint,
      items: loadedItems,
      nextFetcherCursor: resourceResult.nextCursor,
    };
  });

const loadResource = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >,
  fetcherCursor: FetcherCursor | null
): Effect.Effect<
  DocumentSourceLoadedResource<Payload, FetcherCursor, IdentityKey>,
  SourceError
> =>
  Effect.gen(function* () {
    const resourceResult = yield* options.fetcher.read(fetcherCursor);

    return yield* loadResourceResult(options, fetcherCursor, resourceResult);
  });

const countDocuments = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >,
  documents: readonly unknown[]
): Effect.Effect<number, SourceError> =>
  Effect.gen(function* () {
    let count = 0;

    for (const document of documents) {
      const selectedItems = yield* options.selector.select(document);
      count += selectedItems.length;
    }

    return count;
  });

const countResource = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >,
  resourceResult: DocumentFetchResult<Resource, FetcherCursor>
): Effect.Effect<number, SourceError> =>
  Effect.gen(function* () {
    const documents = yield* parseResourceDocuments(
      options.parser,
      resourceResult,
      null,
      {
        sourceItemTotalCount: true,
      }
    );

    return yield* countDocuments(options, documents);
  });

const makeDocumentSourceTotalContext = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >
): DocumentSourceTotalContext<Resource, FetcherCursor, unknown> => ({
  countDocuments: (documents) => countDocuments(options, documents),
  countResource: (resourceResult) => countResource(options, resourceResult),
});

const makeDocumentSourceCountTotal = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >
): (() => Effect.Effect<number, SourceError>) | undefined => {
  const configuredCount = options.countTotal;

  if (configuredCount !== undefined) {
    return Effect.fn("DocumentSource.countTotal")(() =>
      configuredCount(makeDocumentSourceTotalContext(options))
    );
  }

  if (options.fetcher.totalCount?.kind === "single-resource-local") {
    return Effect.fn("DocumentSource.countTotal")(() =>
      options.fetcher
        .read(null)
        .pipe(
          Effect.flatMap((resourceResult) =>
            countResource(options, resourceResult)
          )
        )
    );
  }

  return;
};

const configuredBatchSize = (
  batchSize: number | undefined
): Effect.Effect<number | null, SourceError> => {
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

const startIndexForCursor = <
  Payload,
  FetcherCursor,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  resource: DocumentSourceLoadedResource<Payload, FetcherCursor, IdentityKey>,
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

const makeImplementation = <
  Resource,
  FetcherCursor,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >
): SourceRuntimeImplementation<
  Payload,
  DocumentSourceCursor<FetcherCursor>,
  IdentityKey
> => {
  const identityDefinition = makeDocumentSourceIdentityDefinition(
    options.identity
  );

  const countTotal = makeDocumentSourceCountTotal(options);

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
    identity: SourceIdentity<IdentityKey>
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
          sourceIdentity: identity.encoded,
        }
      );
      const matches = yield* matchingLoadedItems(
        identityDefinition,
        resource.items,
        identity
      );

      if (matches.length > 1) {
        return yield* documentSourceError(
          "Duplicate document source identity",
          {
            sourceIdentity: identity.encoded,
          }
        );
      }

      return matches[0]?.item ?? null;
    }

    let fetcherCursor: FetcherCursor | null = null;
    let found: SourceItemInput<Payload, IdentityKey> | null = null;

    while (true) {
      const resource: DocumentSourceLoadedResource<
        Payload,
        FetcherCursor,
        IdentityKey
      > = yield* loadResource(options, fetcherCursor);
      const matches = yield* matchingLoadedItems(
        identityDefinition,
        resource.items,
        identity
      );

      if (matches.length > 1 || (matches.length === 1 && found !== null)) {
        return yield* documentSourceError(
          "Duplicate document source identity",
          {
            sourceIdentity: identity.encoded,
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
    ...(countTotal === undefined ? {} : { countTotal }),
    lookupStrategy: options.lookup.kind,
    read,
    readByIdentity,
  };
};

function makeSource<
  Resource,
  FetcherCursor,
  Document,
  Selection,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceBaseOptions<
    Resource,
    FetcherCursor,
    Document,
    IdentityKey
  > & {
    readonly identity: DocumentSourceIdentity<
      DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>,
      IdentityKey
    >;
    readonly selector: DocumentSourceItemSelector<Document, Selection>;
    readonly version: DocumentSourceVersion<
      DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>
    >;
  }
): ConfiguredSource<
  DocumentSourceSelectedItem<DocumentSourceCursorFocus<Selection>>,
  DocumentSourceCursor<FetcherCursor>,
  IdentityKey
>;
function makeSource<
  Resource,
  FetcherCursor,
  Document,
  ParentSelection,
  Selection,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options: DocumentSourceBaseOptions<
    Resource,
    FetcherCursor,
    Document,
    IdentityKey
  > & {
    readonly identity: DocumentSourceIdentity<
      DocumentSourceSelectedSubitem<
        DocumentSourceCursorFocus<ParentSelection>,
        DocumentSourceCursorFocus<Selection>
      >,
      IdentityKey
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
): ConfiguredSource<
  DocumentSourceSelectedSubitem<
    DocumentSourceCursorFocus<ParentSelection>,
    DocumentSourceCursorFocus<Selection>
  >,
  DocumentSourceCursor<FetcherCursor>,
  IdentityKey
>;
function makeSource<
  Resource,
  FetcherCursor,
  Document,
  Payload,
  IdentityKey extends SourceIdentitySnapshotKey,
>(
  options:
    | DocumentSourceItemOptions<
        Resource,
        FetcherCursor,
        Document,
        unknown,
        IdentityKey
      >
    | DocumentSourceSubitemOptions<
        Resource,
        FetcherCursor,
        Document,
        unknown,
        unknown,
        IdentityKey
      >
): ConfiguredSource<Payload, DocumentSourceCursor<FetcherCursor>, IdentityKey> {
  const compiledSelector = compileSelector(
    options.parser.documentSchema,
    options.selector
  ) as DocumentSourceCompiledSelector<Payload>;
  const compiledOptions = {
    ...options,
    selector: compiledSelector,
  } as DocumentSourceCompiledOptions<
    Resource,
    FetcherCursor,
    Payload,
    IdentityKey
  >;
  const cursorSchema = makeCursorSchema(options.fetcher.cursorSchema);
  const identity = makeDocumentSourceIdentityDefinition(
    compiledOptions.identity
  );
  return Source.make<Payload, DocumentSourceCursor<FetcherCursor>, IdentityKey>(
    {
      cursorSchema,
      identity,
      make: () => makeImplementation(compiledOptions),
      sourceIdentityContractFingerprint:
        makeDocumentSourceIdentityContractFingerprint(identity),
      sourceSchema: compiledSelector.sourceSchema,
      sourceVersionContractFingerprint:
        makeDocumentSourceVersionContractFingerprint(options.version),
    }
  );
}

export const DocumentSource = {
  make: makeSource,
} as const;
