import { Schema, SchemaRepresentation } from "effect";

export const MigrationDefinitionId = Schema.NonEmptyString.pipe(
  Schema.brand("MigrationDefinitionId")
);
export type MigrationDefinitionId = typeof MigrationDefinitionId.Type;
export type MigrationDefinitionIdInput = string | MigrationDefinitionId;

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

export interface SourceIdentityPart<
  Name extends string,
  Value extends SourceIdentityScalar,
> {
  readonly fingerprint: string;
  readonly name: Name;
  readonly schema: Schema.Codec<Value, unknown, never, never>;
}

type SourceIdentityPartValue<Part> =
  Part extends SourceIdentityPart<string, infer Value> ? Value : never;

type SourceIdentityTupleValue<
  Parts extends readonly SourceIdentityPart<string, SourceIdentityScalar>[],
> = {
  readonly [Index in keyof Parts]: SourceIdentityPartValue<Parts[Index]>;
};

export type SourceIdentitySchemaKind = "scalar" | "tuple";

export interface SourceIdentitySchema<
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly decode: (input: unknown) => Key;
  readonly fingerprint: string;
  readonly kind: SourceIdentitySchemaKind;
  readonly parts: readonly SourceIdentityPart<string, SourceIdentityScalar>[];
}

export interface SourceIdentityDefinition<
  Key extends SourceIdentitySnapshotKey = SourceIdentitySnapshotKey,
> {
  readonly fingerprint: SourceIdentityContractFingerprint;
  readonly id: SourceIdentityContractId;
  readonly schema: SourceIdentitySchema<Key>;
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

const makeEffectSchemaFingerprint = <Value>(
  schema: Schema.Codec<Value, unknown, never, never>
): string => JSON.stringify(SchemaRepresentation.fromAST(schema.ast));

const decodeUriComponent = (text: string): string => decodeURIComponent(text);

const encodeSourceIdentityKey = <Key extends SourceIdentitySnapshotKey>(
  schema: SourceIdentitySchema<Key>,
  key: Key
): EncodedSourceIdentity => {
  const encoded = schema.kind === "scalar" ? String(key) : JSON.stringify(key);

  return EncodedSourceIdentity.make(encoded);
};

const decodeSourceIdentityKey = <Key extends SourceIdentitySnapshotKey>(
  schema: SourceIdentitySchema<Key>,
  encoded: EncodedSourceIdentity
): Key => {
  if (schema.kind === "tuple") {
    return schema.decode(JSON.parse(encoded));
  }

  try {
    return schema.decode(encoded);
  } catch (cause) {
    try {
      return schema.decode(JSON.parse(encoded));
    } catch {
      throw cause;
    }
  }
};

const decodeSourceIdentityScalarText = <Value>(
  schema: Schema.Codec<Value, unknown, never, never>,
  text: string
): Value => {
  const decodedText = decodeUriComponent(text);

  try {
    return Schema.decodeUnknownSync(schema)(decodedText);
  } catch (cause) {
    try {
      return Schema.decodeUnknownSync(schema)(JSON.parse(decodedText));
    } catch {
      throw cause;
    }
  }
};

const decodeSourceIdentityText = <Key extends SourceIdentitySnapshotKey>(
  schema: SourceIdentitySchema<Key>,
  text: string
): Key => {
  if (schema.kind === "scalar") {
    const part = schema.parts[0];

    if (part === undefined) {
      throw new Error("Scalar source identity schema must include one part");
    }

    return schema.decode(decodeSourceIdentityScalarText(part.schema, text));
  }

  const textParts = text.split(sourceIdentityTupleTextDelimiter);

  if (textParts.length !== schema.parts.length) {
    throw new Error(
      `Expected ${schema.parts.length} source identity part(s), received ${textParts.length}`
    );
  }

  const parts = textParts.map((partText, index) => {
    const part = schema.parts[index];

    if (part === undefined) {
      throw new Error(`Unexpected source identity part at index ${index}`);
    }

    return decodeSourceIdentityScalarText(part.schema, partText);
  });

  return schema.decode(parts);
};

const makeSourceIdentityFingerprint = <Key extends SourceIdentitySnapshotKey>(
  id: SourceIdentityContractId,
  schema: SourceIdentitySchema<Key>
): SourceIdentityContractFingerprint =>
  SourceIdentityContractFingerprint.make(
    JSON.stringify({
      id,
      kind: schema.kind,
      parts: schema.parts.map((part, index) => ({
        index,
        name: part.name,
        schema: part.fingerprint,
      })),
      schema: schema.fingerprint,
    })
  );

const makeSourceIdentityDefinition = <
  Key extends SourceIdentitySnapshotKey,
>(input: {
  readonly id: SourceIdentityContractIdInput;
  readonly schema: SourceIdentitySchema<Key>;
}): SourceIdentityDefinition<Key> => {
  const id = SourceIdentityContractId.make(input.id);

  return {
    id,
    schema: input.schema,
    fingerprint: makeSourceIdentityFingerprint(id, input.schema),
  };
};

const makeSourceIdentity = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  key: Key
): SourceIdentity<Key> => {
  const decodedKey = definition.schema.decode(key);

  return {
    encoded: encodeSourceIdentityKey(definition.schema, decodedKey),
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
  const key = decodeSourceIdentityKey(definition.schema, encodedIdentity);

  return makeSourceIdentity(definition, key);
};

const makeSourceIdentityFromText = <Key extends SourceIdentitySnapshotKey>(
  definition: SourceIdentityDefinition<Key>,
  text: string
): SourceIdentity<Key> => {
  const key = decodeSourceIdentityText(definition.schema, text);

  return makeSourceIdentity(definition, key);
};

const makeSourceIdentityPart = <
  Name extends string,
  Value extends SourceIdentityScalar,
>(
  name: Name,
  schema: Schema.Codec<Value, unknown, never, never>
): SourceIdentityPart<Name, Value> => ({
  fingerprint: makeEffectSchemaFingerprint(schema),
  name,
  schema,
});

const makeScalarSourceIdentitySchema = <
  Name extends string,
  Value extends SourceIdentityScalar,
>(
  name: Name,
  schema: Schema.Codec<Value, unknown, never, never>
): SourceIdentitySchema<Value> => {
  const part = makeSourceIdentityPart(name, schema);

  return {
    decode: (input) => Schema.decodeUnknownSync(schema)(input),
    fingerprint: JSON.stringify({
      kind: "scalar",
      schema: part.fingerprint,
    }),
    kind: "scalar",
    parts: [part],
  };
};

function makeTupleSourceIdentitySchema<
  const Parts extends readonly [
    SourceIdentityPart<string, SourceIdentityScalar>,
    ...SourceIdentityPart<string, SourceIdentityScalar>[],
  ],
>(parts: Parts): SourceIdentitySchema<SourceIdentityTupleValue<Parts>>;
function makeTupleSourceIdentitySchema(
  parts: readonly [
    SourceIdentityPart<string, SourceIdentityScalar>,
    ...SourceIdentityPart<string, SourceIdentityScalar>[],
  ]
): SourceIdentitySchema<readonly SourceIdentityScalar[]> {
  return {
    decode: (input) => {
      if (!Array.isArray(input)) {
        throw new Error("Tuple source identity key must be an array");
      }

      if (input.length !== parts.length) {
        throw new Error(
          `Expected ${parts.length} source identity part(s), received ${input.length}`
        );
      }

      return parts.map((part, index) =>
        Schema.decodeUnknownSync(part.schema)(input[index])
      );
    },
    fingerprint: JSON.stringify({
      kind: "tuple",
      parts: parts.map((part, index) => ({
        index,
        name: part.name,
        schema: part.fingerprint,
      })),
    }),
    kind: "tuple",
    parts,
  };
}

export const SourceIdentity = {
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

export const DestinationIdentity = Schema.NonEmptyString.pipe(
  Schema.brand("DestinationIdentity")
);
export type DestinationIdentity = typeof DestinationIdentity.Type;
export type DestinationIdentityInput = string | DestinationIdentity;

export const DestinationVersion = Schema.NonEmptyString.pipe(
  Schema.brand("DestinationVersion")
);
export type DestinationVersion = typeof DestinationVersion.Type;
export type DestinationVersionInput = string | DestinationVersion;

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

export const toDestinationIdentity = (
  value: DestinationIdentityInput
): DestinationIdentity => DestinationIdentity.make(value);

export const toDestinationVersion = (
  value: DestinationVersionInput
): DestinationVersion => DestinationVersion.make(value);

export const toMigrationDefinitionLockToken = (
  value: MigrationDefinitionLockTokenInput
): MigrationDefinitionLockToken => MigrationDefinitionLockToken.make(value);
