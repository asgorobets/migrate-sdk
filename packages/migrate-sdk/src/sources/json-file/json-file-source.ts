import { Effect, Layer, Schema, SchemaAST } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import {
  type ConfiguredSourcePlugin,
  defineSourcePlugin,
  type SourcePluginImplementation,
} from "../../domain/definition.ts";
import { SourcePluginError } from "../../domain/errors.ts";
import type { SourceIdentityInput } from "../../domain/ids.ts";
import type { SourceItemInput } from "../../domain/source.ts";
import {
  type AnySourcePlugin,
  SourcePlugin,
} from "../../services/source-plugin.ts";

export type JsonFileSourcePlatform = Layer.Layer<FileSystem | Path>;

export interface JsonFileItemsPath {
  readonly path: string;
}

export type JsonFileIdentity =
  | {
      readonly field: string;
      readonly kind: "field";
    }
  | {
      readonly fields: readonly string[];
      readonly kind: "fields";
    };

export type JsonFileVersion =
  | {
      readonly field: string;
      readonly kind: "field";
    }
  | {
      readonly kind: "content-hash";
    };

export interface JsonFileSourceOptions<Source> {
  readonly batchSize?: number;
  readonly identity: JsonFileIdentity;
  readonly items: JsonFileItemsPath;
  readonly path: string;
  readonly platform: JsonFileSourcePlatform;
  readonly sourceSchema: Schema.Codec<Source, unknown, never, never>;
  readonly version: JsonFileVersion;
}

export type JsonFileSchema<Decoded = unknown> = Schema.Codec<
  Decoded,
  unknown,
  never,
  never
>;

type JsonFileCursorFocus<Value> =
  Value extends ReadonlyArray<infer Element> ? Element : Value;

type JsonFileObjectKeys<Value> = Extract<keyof Value, string>;

export type JsonFileIdentityScalar = boolean | number | string;

export type JsonFileIdentityValue =
  | JsonFileIdentityScalar
  | readonly JsonFileIdentityScalar[];

export interface JsonFilePathSegment {
  readonly key: string;
  readonly kind: "array" | "property";
}

interface JsonFileSchemaCursorState<Source> {
  readonly path: readonly JsonFilePathSegment[];
  readonly schema: JsonFileSchema<Source>;
}

export interface JsonFileSelectedItem<Item> {
  readonly item: Item;
}

export interface JsonFileSelectedSubitem<Parent, Item> {
  readonly item: Item;
  readonly parent: Parent;
}

interface JsonFileCompiledDocumentItems<Source> {
  readonly select: (
    document: unknown
  ) => Effect.Effect<readonly unknown[], SourcePluginError>;
  readonly sourceSchema: JsonFileSchema<Source>;
}

declare const jsonFileSchemaSelectionType: unique symbol;

export interface JsonFileSchemaSelection<Source> {
  readonly [jsonFileSchemaSelectionType]: (source: Source) => Source;
}

export type JsonFileSchemaCursor<Source> = JsonFileSchemaSelection<Source> &
  (JsonFileCursorFocus<Source> extends object
    ? {
        readonly [Key in JsonFileObjectKeys<
          JsonFileCursorFocus<Source>
        >]: JsonFileSchemaCursor<JsonFileCursorFocus<Source>[Key]>;
      }
    : Record<never, never>);

export interface JsonFileDocumentItemSelectors<Document, Selection> {
  readonly parentSelector?: never;
  readonly selector: (
    document: JsonFileSchemaCursor<Document>
  ) => JsonFileSchemaSelection<Selection>;
}

export interface JsonFileDocumentSubitemSelectors<
  Document,
  ParentSelection,
  Selection,
> {
  readonly parentSelector: (
    document: JsonFileSchemaCursor<Document>
  ) => JsonFileSchemaSelection<ParentSelection>;
  readonly selector: (
    parent: JsonFileSchemaCursor<JsonFileCursorFocus<ParentSelection>>
  ) => JsonFileSchemaSelection<Selection>;
}

export type JsonFileDocumentIdentity<Source> = (
  item: Source
) => JsonFileIdentityValue;

export type JsonFileDocumentVersion<Source> =
  | {
      readonly kind: "content-hash";
    }
  | {
      readonly kind: "value";
      readonly value: (item: Source) => JsonFileIdentityScalar;
    };

export interface JsonFileDocumentSourceBaseOptions<Document> {
  readonly batchSize?: number;
  readonly documentSchema: JsonFileSchema<Document>;
  readonly path: string;
  readonly platform: JsonFileSourcePlatform;
}

export interface JsonFileDocumentItemSourceOptions<Document, Selection>
  extends JsonFileDocumentSourceBaseOptions<Document> {
  readonly identity: JsonFileDocumentIdentity<
    JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
  >;
  readonly items: JsonFileDocumentItemSelectors<Document, Selection>;
  readonly version: JsonFileDocumentVersion<
    JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
  >;
}

export interface JsonFileDocumentSubitemSourceOptions<
  Document,
  ParentSelection,
  Selection,
> extends JsonFileDocumentSourceBaseOptions<Document> {
  readonly identity: JsonFileDocumentIdentity<
    JsonFileSelectedSubitem<
      JsonFileCursorFocus<ParentSelection>,
      JsonFileCursorFocus<Selection>
    >
  >;
  readonly items: JsonFileDocumentSubitemSelectors<
    Document,
    ParentSelection,
    Selection
  >;
  readonly version: JsonFileDocumentVersion<
    JsonFileSelectedSubitem<
      JsonFileCursorFocus<ParentSelection>,
      JsonFileCursorFocus<Selection>
    >
  >;
}

interface JsonFileCompiledDocumentSourceOptions<Document, Source>
  extends JsonFileDocumentSourceBaseOptions<Document> {
  readonly identity: JsonFileDocumentIdentity<Source>;
  readonly items: JsonFileCompiledDocumentItems<Source>;
  readonly version: JsonFileDocumentVersion<Source>;
}

export const JsonFileSourceCursor = Schema.Struct({
  fileFingerprint: Schema.String,
  nextItemIndex: Schema.Int,
});

export type JsonFileSourceCursor = typeof JsonFileSourceCursor.Type;

interface JsonFileDocument<Source> {
  readonly fileFingerprint: string;
  readonly items: readonly SourceItemInput<Source>[];
}

interface JsonFileSelectionFrame {
  readonly pathValues: ReadonlyMap<string, unknown>;
  readonly value: unknown;
}

const textEncoder = new TextEncoder();
const jsonFileSchemaCursorState = Symbol("JsonFileSchemaCursorState");

const jsonFileError = (message: string, cause?: unknown): SourcePluginError =>
  new SourcePluginError({
    message,
    ...(cause === undefined ? {} : { cause }),
  });

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
    catch: (cause) => jsonFileError("Unable to hash JSON file contents", cause),
  });

const readFileBytes = (
  fs: FileSystem,
  path: Path,
  filePath: string
): Effect.Effect<
  { readonly bytes: Uint8Array; readonly resolvedPath: string },
  SourcePluginError
> => {
  const resolvedPath = path.resolve(filePath);

  return fs.readFile(resolvedPath).pipe(
    Effect.map((bytes) => ({
      bytes,
      resolvedPath,
    })),
    Effect.mapError((cause) =>
      jsonFileError("Unable to read JSON source file", {
        cause,
        path: filePath,
        resolvedPath,
      })
    )
  );
};

const decodeUtf8 = (
  bytes: Uint8Array,
  resolvedPath: string
): Effect.Effect<string, SourcePluginError> =>
  Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) =>
      jsonFileError("Unable to decode JSON source file as UTF-8", {
        cause,
        path: resolvedPath,
      }),
  });

const parseJson = (
  input: string,
  resolvedPath: string
): Effect.Effect<unknown, SourcePluginError> =>
  Effect.try({
    try: () => JSON.parse(input) as unknown,
    catch: (cause) =>
      jsonFileError("Unable to parse JSON source file", {
        cause,
        path: resolvedPath,
      }),
  });

const parseItemsPath = (
  pathExpression: string
): Effect.Effect<readonly string[], SourcePluginError> =>
  Effect.sync(() => pathExpression.trim()).pipe(
    Effect.flatMap((path) => {
      if (path === "$") {
        return Effect.succeed([]);
      }

      if (!(path.startsWith("$.") && path.length > 2)) {
        return Effect.fail(
          jsonFileError("JSON file items path must use $.field syntax", {
            path,
          })
        );
      }

      const segments = path
        .slice(2)
        .split(".")
        .map((segment) => segment.trim());

      if (segments.some((segment) => segment.length === 0)) {
        return Effect.fail(
          jsonFileError("JSON file items path segment must not be blank", {
            path,
          })
        );
      }

      return Effect.succeed(segments);
    })
  );

const selectItems = (
  root: unknown,
  pathExpression: string
): Effect.Effect<readonly unknown[], SourcePluginError> =>
  Effect.gen(function* () {
    const segments = yield* parseItemsPath(pathExpression);
    let selected = root;

    for (const segment of segments) {
      if (
        typeof selected !== "object" ||
        selected === null ||
        Array.isArray(selected)
      ) {
        return yield* jsonFileError("JSON file items path was not found", {
          path: pathExpression,
          segment,
        });
      }

      selected = (selected as Record<string, unknown>)[segment];
    }

    if (!Array.isArray(selected)) {
      return yield* jsonFileError(
        "JSON file items path must resolve to array",
        {
          path: pathExpression,
        }
      );
    }

    return selected;
  });

const normalizeFields = (
  fields: readonly string[],
  label: string
): Effect.Effect<readonly string[], SourcePluginError> =>
  Effect.gen(function* () {
    const normalized = fields.map((field) => field.trim());
    const seen = new Set<string>();

    if (normalized.length === 0) {
      return yield* jsonFileError(`${label} must include at least one field`);
    }

    for (const [index, field] of normalized.entries()) {
      if (field.length === 0) {
        return yield* jsonFileError(`${label} field must not be blank`, {
          fieldIndex: index,
        });
      }

      if (seen.has(field)) {
        return yield* jsonFileError(`${label} fields must be unique`, {
          field,
        });
      }

      seen.add(field);
    }

    return normalized;
  });

const fieldsForIdentity = (
  identity: JsonFileIdentity
): Effect.Effect<readonly string[], SourcePluginError> =>
  identity.kind === "field"
    ? normalizeFields([identity.field], "JSON file identity")
    : normalizeFields(identity.fields, "JSON file identity");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pathKey = (segments: readonly JsonFilePathSegment[]): string =>
  segments.map((segment) => `${segment.key}:${segment.kind}`).join("/");

const isNamedSchema = (value: unknown): value is JsonFileSchema =>
  typeof value === "object" && value !== null && "ast" in value;

const hasStructFields = (
  value: JsonFileSchema
): value is JsonFileSchema & {
  readonly fields: Record<string, JsonFileSchema>;
} =>
  "fields" in value &&
  isRecord(value.fields) &&
  Object.values(value.fields).every(isNamedSchema);

const arrayElementSchema = (value: JsonFileSchema): JsonFileSchema | null => {
  if (!SchemaAST.isArrays(value.ast)) {
    return null;
  }

  const runtimeArraySchema = value as JsonFileSchema & {
    readonly schema?: unknown;
    readonly value?: unknown;
  };
  const elementSchema = runtimeArraySchema.schema ?? runtimeArraySchema.value;

  return isNamedSchema(elementSchema) ? elementSchema : null;
};

const selectProjectionPath = (
  document: unknown,
  segments: readonly JsonFilePathSegment[]
): Effect.Effect<readonly JsonFileSelectionFrame[], SourcePluginError> =>
  Effect.gen(function* () {
    let frames: readonly JsonFileSelectionFrame[] = [
      {
        pathValues: new Map([["", document]]),
        value: document,
      },
    ];
    let currentPath: readonly JsonFilePathSegment[] = [];

    for (const segment of segments) {
      currentPath = [...currentPath, segment];
      const currentPathKey = pathKey(currentPath);
      const nextFrames: JsonFileSelectionFrame[] = [];

      for (const frame of frames) {
        if (!isRecord(frame.value)) {
          return yield* jsonFileError(
            "JSON file projection path was not found",
            {
              path: currentPath,
              segment,
            }
          );
        }

        const selected = frame.value[segment.key];

        if (segment.kind === "array") {
          if (!Array.isArray(selected)) {
            return yield* jsonFileError(
              "JSON file projection path must resolve to array",
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

const makeSchemaCursor = <Source>(
  schema: JsonFileSchema<Source>,
  path: readonly JsonFilePathSegment[]
): JsonFileSchemaCursor<Source> =>
  new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === jsonFileSchemaCursorState) {
          return {
            path,
            schema,
          } satisfies JsonFileSchemaCursorState<Source>;
        }

        if (typeof property !== "string") {
          return undefined;
        }

        if (!hasStructFields(schema)) {
          throw new Error(
            `JSON file projection field cannot be selected from a non-object schema: ${property}`
          );
        }

        const fieldSchema = schema.fields[property];

        if (fieldSchema === undefined) {
          throw new Error(
            `JSON file projection field was not found: ${property}`
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
  ) as JsonFileSchemaCursor<Source>;

const schemaCursorState = <Source>(
  cursor: unknown
): JsonFileSchemaCursorState<JsonFileCursorFocus<Source>> => {
  const state = (
    cursor as {
      readonly [jsonFileSchemaCursorState]?:
        | JsonFileSchemaCursorState<JsonFileCursorFocus<Source>>
        | undefined;
    }
  )[jsonFileSchemaCursorState];

  if (state === undefined) {
    throw new Error("JSON file selector must return a schema cursor");
  }

  return state;
};

const assertArraySelection = (
  state: JsonFileSchemaCursorState<unknown>,
  label: string
): void => {
  if (state.path.at(-1)?.kind !== "array") {
    throw new Error(`${label} must select an array field`);
  }
};

const isPathPrefix = (
  prefix: readonly JsonFilePathSegment[],
  path: readonly JsonFilePathSegment[]
): boolean =>
  prefix.length <= path.length &&
  prefix.every(
    (segment, index) =>
      path[index]?.key === segment.key && path[index]?.kind === segment.kind
  );

const hasParentSelector = <Document>(
  items:
    | JsonFileDocumentItemSelectors<Document, unknown>
    | JsonFileDocumentSubitemSelectors<Document, unknown, unknown>
): items is JsonFileDocumentSubitemSelectors<Document, unknown, unknown> =>
  "parentSelector" in items;

const compileItemSelectors = <Document, Selection>(
  documentSchema: JsonFileSchema<Document>,
  selectors: JsonFileDocumentItemSelectors<Document, Selection>
): JsonFileCompiledDocumentItems<
  JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
> => {
  const rootCursor = makeSchemaCursor(documentSchema, []);
  const itemState = schemaCursorState<JsonFileCursorFocus<Selection>>(
    selectors.selector(rootCursor)
  );
  assertArraySelection(itemState, "JSON file item selector");
  const sourceSchema = Schema.Struct({
    item: itemState.schema,
  }) as unknown as JsonFileSchema<
    JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
  >;
  const select = (
    document: unknown
  ): Effect.Effect<readonly unknown[], SourcePluginError> =>
    selectProjectionPath(document, itemState.path).pipe(
      Effect.map((frames) => frames.map((frame) => ({ item: frame.value })))
    );

  return {
    select,
    sourceSchema,
  };
};

const compileSubitemSelectors = <Document, ParentSelection, Selection>(
  documentSchema: JsonFileSchema<Document>,
  selectors: JsonFileDocumentSubitemSelectors<
    Document,
    ParentSelection,
    Selection
  >
): JsonFileCompiledDocumentItems<
  JsonFileSelectedSubitem<
    JsonFileCursorFocus<ParentSelection>,
    JsonFileCursorFocus<Selection>
  >
> => {
  const rootCursor = makeSchemaCursor(documentSchema, []);
  const parentState = schemaCursorState<JsonFileCursorFocus<ParentSelection>>(
    selectors.parentSelector(rootCursor)
  );
  assertArraySelection(parentState, "JSON file parentSelector");
  const itemState = schemaCursorState<JsonFileCursorFocus<Selection>>(
    selectors.selector(
      parentStateCursor(parentState) as JsonFileSchemaCursor<
        JsonFileCursorFocus<ParentSelection>
      >
    )
  );
  assertArraySelection(itemState, "JSON file selector");

  if (!isPathPrefix(parentState.path, itemState.path)) {
    throw new Error("JSON file selector must be nested under parentSelector");
  }

  const parentPathKey = pathKey(parentState.path);
  const sourceSchema = Schema.Struct({
    item: itemState.schema,
    parent: parentState.schema,
  }) as unknown as JsonFileSchema<
    JsonFileSelectedSubitem<
      JsonFileCursorFocus<ParentSelection>,
      JsonFileCursorFocus<Selection>
    >
  >;
  const select = (
    document: unknown
  ): Effect.Effect<readonly unknown[], SourcePluginError> =>
    selectProjectionPath(document, itemState.path).pipe(
      Effect.flatMap((frames) =>
        Effect.forEach(frames, (frame, itemIndex) => {
          if (!frame.pathValues.has(parentPathKey)) {
            return Effect.fail(
              jsonFileError(
                "JSON file parent selection was not found for item",
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
    );

  return {
    select,
    sourceSchema,
  };
};

const parentStateCursor = <Source>(
  state: JsonFileSchemaCursorState<Source>
): JsonFileSchemaCursor<Source> => makeSchemaCursor(state.schema, state.path);

const compileDocumentItems = <Document>(
  documentSchema: JsonFileSchema<Document>,
  selectors:
    | JsonFileDocumentItemSelectors<Document, unknown>
    | JsonFileDocumentSubitemSelectors<Document, unknown, unknown>
): JsonFileCompiledDocumentItems<unknown> =>
  hasParentSelector(selectors)
    ? compileSubitemSelectors(documentSchema, selectors)
    : compileItemSelectors(documentSchema, selectors);

const stringifyFieldValue = (
  value: unknown,
  field: string,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    if (value === undefined || value === null) {
      return yield* jsonFileError(`JSON file ${label} field was not found`, {
        field,
        itemIndex,
      });
    }

    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return yield* jsonFileError(
        `JSON file ${label} field must be a scalar value`,
        { field, itemIndex, value }
      );
    }

    const stringValue = String(value).trim();

    if (stringValue.length === 0) {
      return yield* jsonFileError(
        `JSON file ${label} value must not be empty`,
        {
          field,
          itemIndex,
        }
      );
    }

    return stringValue;
  });

const stringifyIdentityValue = (
  value: JsonFileIdentityScalar,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourcePluginError> =>
  stringifyFieldValue(value, label, itemIndex, label);

const isIdentityValueArray = (
  value: JsonFileIdentityValue
): value is readonly JsonFileIdentityScalar[] => Array.isArray(value);

const normalizeIdentityValue = (
  value: JsonFileIdentityValue,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    if (isIdentityValueArray(value)) {
      if (value.length === 0) {
        return yield* jsonFileError(
          `JSON file ${label} value must include at least one scalar value`,
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

const fieldValue = (
  item: unknown,
  field: string,
  itemIndex: number,
  label: "identity" | "version"
): Effect.Effect<string, SourcePluginError> =>
  isRecord(item)
    ? stringifyFieldValue(item[field], field, itemIndex, label)
    : Effect.fail(
        jsonFileError(`JSON file ${label} item must be an object`, {
          field,
          itemIndex,
        })
      );

const buildIdentity = (
  item: unknown,
  identity: JsonFileIdentity,
  itemIndex: number
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    const fields = yield* fieldsForIdentity(identity);
    const values = yield* Effect.forEach(fields, (field) =>
      fieldValue(item, field, itemIndex, "identity")
    );

    return values.length === 1 ? (values[0] as string) : JSON.stringify(values);
  });

const encodeSourceItemJson = <Source>(
  item: Source,
  sourceSchema: Schema.Codec<Source, unknown, never, never>,
  itemIndex: number
): Effect.Effect<string, SourcePluginError> =>
  Schema.encodeEffect(Schema.fromJsonString(sourceSchema))(item).pipe(
    Effect.mapError((cause) =>
      jsonFileError("Unable to encode JSON file item for content hash", {
        cause,
        itemIndex,
      })
    )
  );

const buildVersion = <Source>(
  item: Source,
  version: JsonFileVersion,
  sourceSchema: Schema.Codec<Source, unknown, never, never>,
  itemIndex: number
): Effect.Effect<string, SourcePluginError> =>
  Effect.gen(function* () {
    switch (version.kind) {
      case "field":
        return yield* fieldValue(item, version.field, itemIndex, "version");
      case "content-hash": {
        const material = yield* encodeSourceItemJson(
          item,
          sourceSchema,
          itemIndex
        );

        return yield* sha256Hex(textEncoder.encode(material));
      }
      default: {
        const unhandledVersion: never = version;
        throw new Error(
          `Unhandled JSON file version configuration: ${unhandledVersion}`
        );
      }
    }
  });

const buildDocumentIdentity = <Source>(
  item: Source,
  identity: JsonFileDocumentIdentity<Source>,
  itemIndex: number
): Effect.Effect<string, SourcePluginError> =>
  Effect.try({
    try: () => identity(item),
    catch: (cause) =>
      jsonFileError("Unable to build JSON file source identity", {
        cause,
        itemIndex,
      }),
  }).pipe(
    Effect.flatMap((identityValue) =>
      normalizeIdentityValue(identityValue, itemIndex, "identity")
    )
  );

const buildDocumentVersion = <Source>(
  item: Source,
  version: JsonFileDocumentVersion<Source>,
  sourceSchema: Schema.Codec<Source, unknown, never, never>,
  itemIndex: number
): Effect.Effect<string, SourcePluginError> =>
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
            jsonFileError("Unable to build JSON file source version", {
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
          `Unhandled JSON file document version configuration: ${unhandledVersion}`
        );
      }
    }
  });

const decodeSourceItem = <Source>(
  rawItem: unknown,
  itemIndex: number,
  options: JsonFileSourceOptions<Source>
): Effect.Effect<SourceItemInput<Source>, SourcePluginError> =>
  Effect.gen(function* () {
    const item = yield* Schema.decodeUnknownEffect(options.sourceSchema)(
      rawItem
    ).pipe(
      Effect.mapError((cause) =>
        jsonFileError("JSON file item did not match Source Payload Schema", {
          cause,
          itemIndex,
        })
      )
    );
    const identity = yield* buildIdentity(item, options.identity, itemIndex);
    const version = yield* buildVersion(
      item,
      options.version,
      options.sourceSchema,
      itemIndex
    );

    return {
      identity,
      item,
      version,
    };
  });

const decodeDocumentSourceItem = <Source>(
  rawItem: unknown,
  itemIndex: number,
  options: JsonFileCompiledDocumentSourceOptions<unknown, Source>
): Effect.Effect<SourceItemInput<Source>, SourcePluginError> =>
  Effect.gen(function* () {
    const item = yield* Schema.decodeUnknownEffect(options.items.sourceSchema)(
      rawItem
    ).pipe(
      Effect.mapError((cause) =>
        jsonFileError("JSON file item did not match Source Payload Schema", {
          cause,
          itemIndex,
        })
      )
    );
    const identity = yield* buildDocumentIdentity(
      item,
      options.identity,
      itemIndex
    );
    const version = yield* buildDocumentVersion(
      item,
      options.version,
      options.items.sourceSchema,
      itemIndex
    );

    return {
      identity,
      item,
      version,
    };
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
        jsonFileError("JSON file source batchSize must be a positive integer", {
          batchSize,
        })
      );
};

const ensureUniqueIdentities = <Source>(
  items: readonly SourceItemInput<Source>[]
): Effect.Effect<void, SourcePluginError> =>
  Effect.gen(function* () {
    const identityIndexes = new Map<string, number>();

    for (const [itemIndex, item] of items.entries()) {
      const existingIndex = identityIndexes.get(item.identity);

      if (existingIndex !== undefined) {
        return yield* jsonFileError("Duplicate JSON file source identity", {
          duplicateItemIndex: itemIndex,
          firstItemIndex: existingIndex,
          sourceIdentity: item.identity,
        });
      }

      identityIndexes.set(item.identity, itemIndex);
    }
  });

const loadDocument = <Source>(
  fs: FileSystem,
  path: Path,
  options: JsonFileSourceOptions<Source>
): Effect.Effect<JsonFileDocument<Source>, SourcePluginError> =>
  Effect.gen(function* () {
    const file = yield* readFileBytes(fs, path, options.path);
    const fileFingerprint = yield* sha256Hex(file.bytes);
    const text = yield* decodeUtf8(file.bytes, file.resolvedPath);
    const root = yield* parseJson(text, file.resolvedPath);
    const rawItems = yield* selectItems(root, options.items.path);
    const items = yield* Effect.forEach(rawItems, (item, itemIndex) =>
      decodeSourceItem(item, itemIndex, options)
    );
    yield* ensureUniqueIdentities(items);

    return {
      fileFingerprint,
      items,
    };
  });

const loadProjectedDocument = <Document, Source>(
  fs: FileSystem,
  path: Path,
  options: JsonFileCompiledDocumentSourceOptions<Document, Source>
): Effect.Effect<JsonFileDocument<Source>, SourcePluginError> =>
  Effect.gen(function* () {
    const file = yield* readFileBytes(fs, path, options.path);
    const fileFingerprint = yield* sha256Hex(file.bytes);
    const text = yield* decodeUtf8(file.bytes, file.resolvedPath);
    const root = yield* parseJson(text, file.resolvedPath);
    yield* Schema.decodeUnknownEffect(options.documentSchema)(root).pipe(
      Effect.mapError((cause) =>
        jsonFileError("JSON file document did not match Document Schema", {
          cause,
        })
      )
    );
    const rawItems = yield* options.items.select(root);
    const items = yield* Effect.forEach(rawItems, (item, itemIndex) =>
      decodeDocumentSourceItem(item, itemIndex, options)
    );
    yield* ensureUniqueIdentities(items);

    return {
      fileFingerprint,
      items,
    };
  });

const makeImplementationWithBatchSize = <Source>(
  batchSize: number | undefined,
  loadDocumentItems: () => Effect.Effect<
    JsonFileDocument<Source>,
    SourcePluginError
  >
): SourcePluginImplementation<Source, JsonFileSourceCursor> => {
  const read = Effect.fn("JsonFileSource.read")(function* (
    cursor: JsonFileSourceCursor | null
  ) {
    const configuredWindowSize = yield* configuredBatchSize(batchSize);
    const document = yield* loadDocumentItems();
    const windowSize = configuredWindowSize ?? document.items.length;
    const startItemIndex =
      cursor?.fileFingerprint === document.fileFingerprint
        ? cursor.nextItemIndex
        : 0;
    const nextItemIndex = startItemIndex + windowSize;
    const items = document.items.slice(startItemIndex, nextItemIndex);

    return {
      items,
      ...(nextItemIndex < document.items.length
        ? {
            nextCursor: {
              fileFingerprint: document.fileFingerprint,
              nextItemIndex,
            } satisfies JsonFileSourceCursor,
          }
        : {}),
    };
  });

  const readByIdentity = Effect.fn("JsonFileSource.readByIdentity")(function* (
    identity: SourceIdentityInput
  ) {
    const document = yield* loadDocumentItems();

    return document.items.find((item) => item.identity === identity) ?? null;
  });

  return {
    lookupStrategy: "scan",
    read,
    readByIdentity,
  };
};

const makePathImplementation = <Source>(
  options: JsonFileSourceOptions<Source>,
  fs: FileSystem,
  path: Path
): SourcePluginImplementation<Source, JsonFileSourceCursor> => {
  const load = () => loadDocument(fs, path, options);

  return makeImplementationWithBatchSize(options.batchSize, load);
};

const makeDocumentImplementation = <Document, Source>(
  options: JsonFileCompiledDocumentSourceOptions<Document, Source>,
  fs: FileSystem,
  path: Path
): SourcePluginImplementation<Source, JsonFileSourceCursor> => {
  const load = () => loadProjectedDocument(fs, path, options);

  return makeImplementationWithBatchSize(options.batchSize, load);
};

const makeLayerWithoutPlatform = <Source>(
  options: JsonFileSourceOptions<Source>
): Layer.Layer<AnySourcePlugin, never, FileSystem | Path> =>
  Layer.effect(
    SourcePlugin,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const configured = defineSourcePlugin({
        cursorSchema: JsonFileSourceCursor,
        make: () => makePathImplementation(options, fs, path),
        sourceSchema: options.sourceSchema,
      });

      return yield* SourcePlugin.pipe(Effect.provide(configured.layer));
    })
  );

const makeLayer = <Source>(
  options: JsonFileSourceOptions<Source>
): Layer.Layer<AnySourcePlugin> =>
  makeLayerWithoutPlatform(options).pipe(Layer.provide(options.platform));

const makeDocumentLayerWithoutPlatform = <Document, Source>(
  options: JsonFileCompiledDocumentSourceOptions<Document, Source>
): Layer.Layer<AnySourcePlugin, never, FileSystem | Path> =>
  Layer.effect(
    SourcePlugin,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const path = yield* Path;
      const configured = defineSourcePlugin({
        cursorSchema: JsonFileSourceCursor,
        make: () => makeDocumentImplementation(options, fs, path),
        sourceSchema: options.items.sourceSchema,
      });

      return yield* SourcePlugin.pipe(Effect.provide(configured.layer));
    })
  );

const makeDocumentLayer = <Document, Source>(
  options: JsonFileCompiledDocumentSourceOptions<Document, Source>
): Layer.Layer<AnySourcePlugin> =>
  makeDocumentLayerWithoutPlatform(options).pipe(
    Layer.provide(options.platform)
  );

function makeFromDocument<Document, Selection>(
  options: JsonFileDocumentSourceBaseOptions<Document> & {
    readonly items: JsonFileDocumentItemSelectors<Document, Selection>;
    readonly identity: JsonFileDocumentIdentity<
      JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
    >;
    readonly version: JsonFileDocumentVersion<
      JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
    >;
  }
): ConfiguredSourcePlugin<
  JsonFileSelectedItem<JsonFileCursorFocus<Selection>>,
  JsonFileSourceCursor
>;
function makeFromDocument<Document, ParentSelection, Selection>(
  options: JsonFileDocumentSourceBaseOptions<Document> & {
    readonly items: JsonFileDocumentSubitemSelectors<
      Document,
      ParentSelection,
      Selection
    >;
    readonly identity: JsonFileDocumentIdentity<
      JsonFileSelectedSubitem<
        JsonFileCursorFocus<ParentSelection>,
        JsonFileCursorFocus<Selection>
      >
    >;
    readonly version: JsonFileDocumentVersion<
      JsonFileSelectedSubitem<
        JsonFileCursorFocus<ParentSelection>,
        JsonFileCursorFocus<Selection>
      >
    >;
  }
): ConfiguredSourcePlugin<
  JsonFileSelectedSubitem<
    JsonFileCursorFocus<ParentSelection>,
    JsonFileCursorFocus<Selection>
  >,
  JsonFileSourceCursor
>;
function makeFromDocument<Document, Source>(
  options:
    | JsonFileDocumentItemSourceOptions<Document, unknown>
    | JsonFileDocumentSubitemSourceOptions<Document, unknown, unknown>
): ConfiguredSourcePlugin<Source, JsonFileSourceCursor> {
  const compiledItems = compileDocumentItems(
    options.documentSchema,
    options.items
  ) as JsonFileCompiledDocumentItems<Source>;
  const compiledOptions = {
    ...options,
    items: compiledItems,
  } as JsonFileCompiledDocumentSourceOptions<Document, Source>;

  return {
    layer: makeDocumentLayer(compiledOptions),
    sourceSchema: compiledItems.sourceSchema,
  } as ConfiguredSourcePlugin<Source, JsonFileSourceCursor>;
}

const makeJsonFileSource = <Source>(
  options: JsonFileSourceOptions<Source>
): ConfiguredSourcePlugin<Source, JsonFileSourceCursor> =>
  ({
    layer: makeLayer(options),
    sourceSchema: options.sourceSchema,
  }) as ConfiguredSourcePlugin<Source, JsonFileSourceCursor>;

function makeSource<Source>(
  options: JsonFileSourceOptions<Source>
): ConfiguredSourcePlugin<Source, JsonFileSourceCursor>;
function makeSource<Document, Selection>(
  options: JsonFileDocumentSourceBaseOptions<Document> & {
    readonly items: JsonFileDocumentItemSelectors<Document, Selection>;
    readonly identity: JsonFileDocumentIdentity<
      JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
    >;
    readonly version: JsonFileDocumentVersion<
      JsonFileSelectedItem<JsonFileCursorFocus<Selection>>
    >;
  }
): ConfiguredSourcePlugin<
  JsonFileSelectedItem<JsonFileCursorFocus<Selection>>,
  JsonFileSourceCursor
>;
function makeSource<Document, ParentSelection, Selection>(
  options: JsonFileDocumentSourceBaseOptions<Document> & {
    readonly items: JsonFileDocumentSubitemSelectors<
      Document,
      ParentSelection,
      Selection
    >;
    readonly identity: JsonFileDocumentIdentity<
      JsonFileSelectedSubitem<
        JsonFileCursorFocus<ParentSelection>,
        JsonFileCursorFocus<Selection>
      >
    >;
    readonly version: JsonFileDocumentVersion<
      JsonFileSelectedSubitem<
        JsonFileCursorFocus<ParentSelection>,
        JsonFileCursorFocus<Selection>
      >
    >;
  }
): ConfiguredSourcePlugin<
  JsonFileSelectedSubitem<
    JsonFileCursorFocus<ParentSelection>,
    JsonFileCursorFocus<Selection>
  >,
  JsonFileSourceCursor
>;
function makeSource(
  options: unknown
): ConfiguredSourcePlugin<unknown, JsonFileSourceCursor> {
  if (isRecord(options) && "documentSchema" in options) {
    return makeFromDocument(options as never);
  }

  return makeJsonFileSource(options as JsonFileSourceOptions<unknown>);
}

export const JsonFileSourcePlugin = {
  make: makeSource,
  makeFromDocument,
} as const;
