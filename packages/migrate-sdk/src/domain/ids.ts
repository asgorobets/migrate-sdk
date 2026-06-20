import { Schema, SchemaAST, SchemaRepresentation } from "effect";

export const MigrationDefinitionId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrationDefinitionId")
);
export type MigrationDefinitionId = typeof MigrationDefinitionId.Type;
export type MigrationDefinitionIdInput = string | MigrationDefinitionId;

export const MigrationDefinitionRegistryId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrationDefinitionRegistryId")
);
export type MigrationDefinitionRegistryId =
  typeof MigrationDefinitionRegistryId.Type;
export type MigrationDefinitionRegistryIdInput =
  | string
  | MigrationDefinitionRegistryId;

export const MigrationRunId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrationRunId")
);
export type MigrationRunId = typeof MigrationRunId.Type;
export type MigrationRunIdInput = string | MigrationRunId;

export const SourceIdentityContractId = Schema.NonEmptyString.pipe(
  Schema.brand("SourceIdentityContractId")
);
export type SourceIdentityContractId = typeof SourceIdentityContractId.Type;
export type SourceIdentityContractIdInput = string | SourceIdentityContractId;

export const EncodedSourceIdentity = Schema.NonEmptyString.pipe(
  Schema.brand("EncodedSourceIdentity")
);
export type EncodedSourceIdentity = typeof EncodedSourceIdentity.Type;
export type EncodedSourceIdentityInput = string | EncodedSourceIdentity;

export const SourceIdentityContractFingerprint = Schema.NonEmptyString.pipe(
  Schema.brand("SourceIdentityContractFingerprint")
);
export type SourceIdentityContractFingerprint =
  typeof SourceIdentityContractFingerprint.Type;

export const SourceIdentityKeyScalar = Schema.Union([
  Schema.Boolean,
  Schema.Number,
  Schema.String,
]);
export type SourceIdentityKeyScalar = typeof SourceIdentityKeyScalar.Type;

export const SourceIdentitySnapshotKey = Schema.Union([
  SourceIdentityKeyScalar,
  Schema.Array(SourceIdentityKeyScalar),
]);
export type SourceIdentitySnapshotKey = typeof SourceIdentitySnapshotKey.Type;

export type SourceIdentityScalar = SourceIdentityKeyScalar;

const sourceIdentityPartTypeId: unique symbol = Symbol(
  "migrate-sdk/SourceIdentityPart"
);
const sourceIdentitySchemaTypeId: unique symbol = Symbol(
  "migrate-sdk/SourceIdentitySchema"
);
const sourceIdentityPartNameAnnotation = "migrate-sdk/sourceIdentityPartName";

export interface SourceIdentityPart<
  Value extends SourceIdentityScalar,
  Encoded extends SourceIdentityKeyScalar = SourceIdentityKeyScalar,
> extends Schema.Codec<Value, Encoded, never, never> {
  readonly [sourceIdentityPartTypeId]: true;
}

type SourceIdentityPartValue<Part> =
  Part extends Schema.Codec<infer Value, unknown, never, never> ? Value : never;

type SourceIdentityPartEncoded<Part> =
  Part extends Schema.Codec<unknown, infer Encoded, never, never>
    ? Encoded
    : never;

type SourceIdentityTupleValue<
  Parts extends readonly SourceIdentityPart<
    SourceIdentityScalar,
    SourceIdentityKeyScalar
  >[],
> = {
  readonly [Index in keyof Parts]: SourceIdentityPartValue<Parts[Index]>;
};

type SourceIdentityTupleEncoded<
  Parts extends readonly SourceIdentityPart<
    SourceIdentityScalar,
    SourceIdentityKeyScalar
  >[],
> = {
  readonly [Index in keyof Parts]: SourceIdentityPartEncoded<Parts[Index]>;
};

export type SourceIdentitySchemaKind = "scalar" | "tuple";

export interface SourceIdentitySchema<
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends Schema.Codec<Key, EncodedKey, never, never> {
  readonly [sourceIdentitySchemaTypeId]: true;
}

export interface SourceIdentityPartMetadata {
  readonly fingerprint: string;
  readonly name: string;
  readonly schema: Schema.Codec<
    SourceIdentityScalar,
    SourceIdentityKeyScalar,
    never,
    never
  >;
}

interface SourceIdentitySchemaMetadata {
  readonly kind: SourceIdentitySchemaKind;
  readonly parts: readonly SourceIdentityPartMetadata[];
}

export interface SourceIdentityDefinition<
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
  EncodedKey extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly fingerprint: SourceIdentityContractFingerprint;
  readonly id: SourceIdentityContractId;
  readonly kind: SourceIdentitySchemaKind;
  readonly parts: readonly SourceIdentityPartMetadata[];
  readonly schema: SourceIdentitySchema<Key, EncodedKey>;
}

export const SourceIdentitySnapshot = Schema.Struct({
  encoded: EncodedSourceIdentity,
  fingerprint: SourceIdentityContractFingerprint,
  id: SourceIdentityContractId,
  key: SourceIdentitySnapshotKey,
});
export interface SourceIdentitySnapshot<Key = SourceIdentitySnapshotKey> {
  readonly encoded: EncodedSourceIdentity;
  readonly fingerprint: SourceIdentityContractFingerprint;
  readonly id: SourceIdentityContractId;
  readonly key: Key;
}

export interface SourceIdentity<
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> extends SourceIdentitySnapshot<Key> {}

export type SourceIdentityTarget<
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> = SourceIdentity<Key>;

const sourceIdentityTupleTextDelimiter = ":";
const sourceIdentityPartMetadata = new WeakMap<
  object,
  SourceIdentityPartMetadata
>();
const sourceIdentitySchemaMetadata = new WeakMap<
  object,
  SourceIdentitySchemaMetadata
>();

const makeEffectSchemaFingerprint = <Value>(
  schema: Schema.Codec<Value, unknown, never, never>
): string => JSON.stringify(SchemaRepresentation.fromAST(schema.ast));

const isSupportedSourceIdentityScalarTypeAst = (
  ast: SchemaAST.AST
): boolean => {
  if (SchemaAST.isOptional(ast)) {
    return false;
  }

  switch (ast._tag) {
    case "Boolean":
    case "Number":
    case "String":
    case "TemplateLiteral":
      return true;
    case "Literal":
      return (
        typeof ast.literal === "boolean" ||
        typeof ast.literal === "number" ||
        typeof ast.literal === "string"
      );
    case "Union":
      return ast.types.every(isSupportedSourceIdentityScalarTypeAst);
    default:
      return false;
  }
};

const isSupportedSourceIdentityDecodedScalarAst = (
  ast: SchemaAST.AST
): boolean => isSupportedSourceIdentityScalarTypeAst(SchemaAST.toType(ast));

const isSupportedSourceIdentityEncodedScalarAst = (
  ast: SchemaAST.AST
): boolean => isSupportedSourceIdentityScalarTypeAst(SchemaAST.toEncoded(ast));

const assertSourceIdentityPartName = (name: string): void => {
  if (name.length === 0) {
    throw new Error("Source identity part name must not be empty");
  }
};

const assertSupportedSourceIdentityPartAst = (
  name: string,
  ast: SchemaAST.AST
): void => {
  if (!isSupportedSourceIdentityDecodedScalarAst(ast)) {
    throw new Error(
      `Source identity part ${name} must decode to a string, number, or boolean`
    );
  }

  if (!isSupportedSourceIdentityEncodedScalarAst(ast)) {
    throw new Error(
      `Source identity part ${name} must encode to a string, number, or boolean`
    );
  }
};

const assertSupportedSourceIdentityPartSchema = (
  name: string,
  schema: Schema.Codec<
    SourceIdentityScalar,
    SourceIdentityKeyScalar,
    never,
    never
  >
): void => {
  assertSupportedSourceIdentityPartAst(name, schema.ast);
};

const getSourceIdentityPartName = (ast: SchemaAST.AST): string | undefined => {
  const value = ast.context?.annotations?.[sourceIdentityPartNameAnnotation];

  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const sourceIdentitySchemaError = (): Error =>
  new Error(
    "Source identity schema must be built with SourceIdentity.key or SourceIdentity.tuple"
  );

const getSourceIdentitySchemaMetadata = (
  schema: unknown
): SourceIdentitySchemaMetadata => {
  if (typeof schema !== "object" || schema === null) {
    throw sourceIdentitySchemaError();
  }

  const metadata = sourceIdentitySchemaMetadata.get(schema);

  if (
    Reflect.get(schema, sourceIdentitySchemaTypeId) !== true ||
    metadata === undefined
  ) {
    throw sourceIdentitySchemaError();
  }

  return metadata;
};

const isSourceIdentityPart = (
  part: unknown
): part is SourceIdentityPart<
  SourceIdentityScalar,
  SourceIdentityKeyScalar
> => {
  if (typeof part !== "object" || part === null) {
    return false;
  }

  return (
    Reflect.get(part, sourceIdentityPartTypeId) === true &&
    sourceIdentityPartMetadata.has(part)
  );
};

const assertScalarSourceIdentitySchema = (
  schema: SourceIdentitySchema,
  metadata: SourceIdentitySchemaMetadata
): void => {
  if (metadata.kind !== "scalar" || metadata.parts.length !== 1) {
    throw sourceIdentitySchemaError();
  }

  const part = metadata.parts[0];

  if (part === undefined) {
    throw sourceIdentitySchemaError();
  }

  assertSupportedSourceIdentityPartAst(part.name, schema.ast);

  if (getSourceIdentityPartName(schema.ast) !== part.name) {
    throw sourceIdentitySchemaError();
  }
};

const assertTupleSourceIdentitySchema = (
  schema: SourceIdentitySchema,
  metadata: SourceIdentitySchemaMetadata
): void => {
  if (metadata.kind !== "tuple" || !SchemaAST.isArrays(schema.ast)) {
    throw sourceIdentitySchemaError();
  }

  if (schema.ast.rest.length > 0) {
    throw new Error(
      "Tuple source identity schemas with rest elements are not supported"
    );
  }

  if (schema.ast.elements.length !== metadata.parts.length) {
    throw sourceIdentitySchemaError();
  }

  for (let index = 0; index < schema.ast.elements.length; index++) {
    const element = schema.ast.elements[index];
    const part = metadata.parts[index];

    if (element === undefined || part === undefined) {
      throw sourceIdentitySchemaError();
    }

    assertSupportedSourceIdentityPartAst(part.name, element);

    if (getSourceIdentityPartName(element) !== part.name) {
      throw sourceIdentitySchemaError();
    }
  }
};

const assertSourceIdentitySchema = (
  schema: SourceIdentitySchema,
  metadata: SourceIdentitySchemaMetadata
): void => {
  switch (metadata.kind) {
    case "scalar":
      assertScalarSourceIdentitySchema(schema, metadata);
      return;
    case "tuple":
      assertTupleSourceIdentitySchema(schema, metadata);
      return;
    default: {
      const exhaustive: never = metadata.kind;

      throw new Error(`Unsupported source identity schema kind: ${exhaustive}`);
    }
  }
};

const decodeUriComponent = (text: string): string => decodeURIComponent(text);

const encodeSourceIdentityKey = <
  Key extends SourceIdentitySnapshotKey,
  EncodedKey extends SourceIdentitySnapshotKey,
>(
  definition: SourceIdentityDefinition<Key, EncodedKey>,
  key: EncodedKey
): EncodedSourceIdentity => {
  const encoded =
    definition.kind === "scalar" ? String(key) : JSON.stringify(key);

  return EncodedSourceIdentity.make(encoded);
};

const decodeSourceIdentityKey = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  encoded: EncodedSourceIdentity
): Key => {
  if (definition.kind === "tuple") {
    return Schema.decodeUnknownSync(definition.schema)(JSON.parse(encoded));
  }

  try {
    return Schema.decodeUnknownSync(definition.schema)(encoded);
  } catch (cause) {
    try {
      return Schema.decodeUnknownSync(definition.schema)(JSON.parse(encoded));
    } catch {
      throw cause;
    }
  }
};

const parseSourceIdentityScalarTextInput = (
  schema: Schema.Codec<
    SourceIdentityScalar,
    SourceIdentityKeyScalar,
    never,
    never
  >,
  text: string
): unknown => {
  const decodedText = decodeUriComponent(text);

  try {
    Schema.decodeUnknownSync(schema)(decodedText);
    return decodedText;
  } catch (cause) {
    try {
      const parsed = JSON.parse(decodedText);

      Schema.decodeUnknownSync(schema)(parsed);

      return parsed;
    } catch {
      throw cause;
    }
  }
};

const decodeSourceIdentityText = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  text: string
): Key => {
  if (definition.kind === "scalar") {
    const part = definition.parts[0];

    if (part === undefined) {
      throw new Error("Scalar source identity schema must include one part");
    }

    return Schema.decodeUnknownSync(definition.schema)(
      parseSourceIdentityScalarTextInput(part.schema, text)
    );
  }

  const textParts = text.split(sourceIdentityTupleTextDelimiter);

  if (textParts.length !== definition.parts.length) {
    throw new Error(
      `Expected ${definition.parts.length} source identity part(s), received ${textParts.length}`
    );
  }

  const parts = textParts.map((partText, index) => {
    const part = definition.parts[index];

    if (part === undefined) {
      throw new Error(`Unexpected source identity part at index ${index}`);
    }

    return parseSourceIdentityScalarTextInput(part.schema, partText);
  });

  return Schema.decodeUnknownSync(definition.schema)(parts);
};

const makeSourceIdentityFingerprint = (
  id: SourceIdentityContractId,
  schema: SourceIdentitySchema,
  metadata: SourceIdentitySchemaMetadata
): SourceIdentityContractFingerprint =>
  SourceIdentityContractFingerprint.make(
    JSON.stringify({
      id,
      kind: metadata.kind,
      parts: metadata.parts.map((part, index) => ({
        index,
        name: part.name,
        schema: part.fingerprint,
      })),
      schema: makeEffectSchemaFingerprint(schema),
    })
  );

const makeSourceIdentityDefinition = <
  Key extends SourceIdentitySnapshotKey,
  EncodedKey extends SourceIdentitySnapshotKey,
>(input: {
  readonly id: SourceIdentityContractIdInput;
  readonly schema: SourceIdentitySchema<Key, EncodedKey>;
}): SourceIdentityDefinition<Key, EncodedKey> => {
  const id = SourceIdentityContractId.make(input.id);
  const metadata = getSourceIdentitySchemaMetadata(input.schema);

  assertSourceIdentitySchema(input.schema, metadata);

  return {
    id,
    kind: metadata.kind,
    parts: metadata.parts,
    schema: input.schema,
    fingerprint: makeSourceIdentityFingerprint(id, input.schema, metadata),
  };
};

const makeSourceIdentity = <
  Key extends SourceIdentitySnapshotKey,
  EncodedKey extends SourceIdentitySnapshotKey,
>(
  definition: SourceIdentityDefinition<Key, EncodedKey>,
  key: Key
): SourceIdentity<Key> => {
  const encodedKey = Schema.encodeUnknownSync(definition.schema)(key);
  const decodedKey = Schema.decodeUnknownSync(definition.schema)(encodedKey);

  return {
    encoded: encodeSourceIdentityKey(definition, encodedKey),
    fingerprint: definition.fingerprint,
    id: definition.id,
    key: decodedKey,
  };
};

const makeSourceIdentityFromEncoded = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  encoded: EncodedSourceIdentityInput
): SourceIdentity<Key> => {
  const encodedIdentity = toEncodedSourceIdentity(encoded);
  const key = decodeSourceIdentityKey(definition, encodedIdentity);

  return makeSourceIdentity(definition, key);
};

const makeSourceIdentityFromText = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  text: string
): SourceIdentity<Key> => {
  const key = decodeSourceIdentityText(definition, text);

  return makeSourceIdentity(definition, key);
};

const decodeSourceIdentity = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  input: unknown
): Key => Schema.decodeUnknownSync(definition.schema)(input);

const makeSourceIdentityPart = <
  Name extends string,
  Value extends SourceIdentityScalar,
  Encoded extends SourceIdentityKeyScalar,
>(
  name: Name,
  schema: Schema.Codec<Value, Encoded, never, never>
): SourceIdentityPart<Value, Encoded> => {
  assertSourceIdentityPartName(name);
  assertSupportedSourceIdentityPartSchema(name, schema);
  const sourceIdentityPartBrand: {
    readonly [sourceIdentityPartTypeId]: true;
  } = { [sourceIdentityPartTypeId]: true };

  const part = Object.assign(
    schema.pipe(
      Schema.annotateKey({
        [sourceIdentityPartNameAnnotation]: name,
      })
    ),
    sourceIdentityPartBrand
  );

  sourceIdentityPartMetadata.set(part, {
    fingerprint: makeEffectSchemaFingerprint(part),
    name,
    schema: part,
  });

  return part;
};

const makeSourceIdentitySchema = <
  Key extends SourceIdentitySnapshotKey,
  EncodedKey extends SourceIdentitySnapshotKey,
>(
  schema: Schema.Codec<Key, EncodedKey, never, never>,
  metadata: SourceIdentitySchemaMetadata
): SourceIdentitySchema<Key, EncodedKey> => {
  const sourceIdentitySchemaBrand: {
    readonly [sourceIdentitySchemaTypeId]: true;
  } = { [sourceIdentitySchemaTypeId]: true };
  const sourceIdentitySchema = Object.assign(schema, sourceIdentitySchemaBrand);

  sourceIdentitySchemaMetadata.set(sourceIdentitySchema, metadata);

  return sourceIdentitySchema;
};

const getSourceIdentityPartMetadata = (
  part: SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>
): SourceIdentityPartMetadata => {
  const metadata = sourceIdentityPartMetadata.get(part);

  if (metadata === undefined) {
    throw new Error(
      "Source identity tuple parts must be built with SourceIdentity.part"
    );
  }

  return metadata;
};

const getSourceIdentityPartMetadatas = (
  parts: readonly [
    SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>,
    ...SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>[],
  ]
): readonly SourceIdentityPartMetadata[] => {
  if (!parts.every(isSourceIdentityPart)) {
    throw new Error(
      "Source identity tuple parts must be built with SourceIdentity.part"
    );
  }

  return parts.map(getSourceIdentityPartMetadata);
};

const makeScalarSourceIdentitySchema = <
  Name extends string,
  Value extends SourceIdentityScalar,
  Encoded extends SourceIdentityKeyScalar,
>(
  name: Name,
  schema: Schema.Codec<Value, Encoded, never, never>
): SourceIdentitySchema<Value, Encoded> => {
  const part = makeSourceIdentityPart(name, schema);
  const metadata = getSourceIdentityPartMetadata(part);

  return makeSourceIdentitySchema(part, {
    kind: "scalar",
    parts: [metadata],
  });
};

function makeTupleSourceIdentitySchema<
  const Parts extends readonly [
    SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>,
    ...SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>[],
  ],
>(
  parts: Parts
): SourceIdentitySchema<
  SourceIdentityTupleValue<Parts>,
  SourceIdentityTupleEncoded<Parts>
>;
function makeTupleSourceIdentitySchema(
  parts: readonly [
    SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>,
    ...SourceIdentityPart<SourceIdentityScalar, SourceIdentityKeyScalar>[],
  ]
): SourceIdentitySchema<
  readonly SourceIdentityScalar[],
  readonly SourceIdentityKeyScalar[]
> {
  const partMetadatas = getSourceIdentityPartMetadatas(parts);
  const schema = Schema.Tuple(parts);

  return makeSourceIdentitySchema(schema, {
    kind: "tuple",
    parts: partMetadatas,
  });
}

export const SourceIdentity = {
  decode: decodeSourceIdentity,
  fromEncoded: makeSourceIdentityFromEncoded,
  fromKey: makeSourceIdentity,
  fromText: makeSourceIdentityFromText,
  key: makeScalarSourceIdentitySchema,
  make: makeSourceIdentityDefinition,
  part: makeSourceIdentityPart,
  tuple: makeTupleSourceIdentitySchema,
} as const;

export const SourceVersion = Schema.NonEmptyString.pipe(
  Schema.brand("SourceVersion")
);
export type SourceVersion = typeof SourceVersion.Type;
export type SourceVersionInput = string | SourceVersion;

export const EncodedSourceCursor = Schema.String.pipe(
  Schema.brand("EncodedSourceCursor")
);
export type EncodedSourceCursor = typeof EncodedSourceCursor.Type;
export type EncodedSourceCursorInput = string | EncodedSourceCursor;

export const MigrationDefinitionLockToken = Schema.NonEmptyString.pipe(
  Schema.brand("MigrationDefinitionLockToken")
);
export type MigrationDefinitionLockToken =
  typeof MigrationDefinitionLockToken.Type;
export type MigrationDefinitionLockTokenInput =
  | string
  | MigrationDefinitionLockToken;

export const toMigrationDefinitionId = (
  value: MigrationDefinitionIdInput
): MigrationDefinitionId => MigrationDefinitionId.make(value);

export const toMigrationDefinitionRegistryId = (
  value: MigrationDefinitionRegistryIdInput
): MigrationDefinitionRegistryId => MigrationDefinitionRegistryId.make(value);

export const toMigrationRunId = (value: MigrationRunIdInput): MigrationRunId =>
  MigrationRunId.make(value);

export const toEncodedSourceIdentity = (
  value: EncodedSourceIdentityInput
): EncodedSourceIdentity => EncodedSourceIdentity.make(value);

export const toSourceVersion = (value: SourceVersionInput): SourceVersion =>
  SourceVersion.make(value);

export const toEncodedSourceCursor = (
  value: EncodedSourceCursorInput
): EncodedSourceCursor => EncodedSourceCursor.make(value);

export const toMigrationDefinitionLockToken = (
  value: MigrationDefinitionLockTokenInput
): MigrationDefinitionLockToken => MigrationDefinitionLockToken.make(value);
