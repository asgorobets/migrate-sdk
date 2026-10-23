import { Effect, Option, Schema, SchemaAST, SchemaIssue } from "effect";

// The store owns this envelope metadata. Paths use individual keys so dots,
// slashes, array indexes and user-defined property names remain unambiguous.
const NullFields = Schema.Array(Schema.NonEmptyArray(Schema.String));
type JsonCodec = Schema.Codec<unknown, unknown, never, never>;
const fieldDecoders = new WeakMap<
  SchemaAST.AST,
  (value: unknown) => Option.Option<unknown>
>();

const decoderFor = (ast: SchemaAST.AST) => {
  let decoder = fieldDecoders.get(ast);
  if (decoder === undefined) {
    decoder = Schema.decodeUnknownOption(Schema.make<JsonCodec>(ast));
    fieldDecoders.set(ast, decoder);
  }
  return decoder;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Inspect encoded keys, but ask the original field codec whether null is valid.
// Do not replace the domain codec or strip fields while selecting a union branch.
const backfillNullableFields = (
  ast: SchemaAST.AST,
  value: unknown
): unknown => {
  const encoded = ast.encoding?.at(-1);
  if (encoded !== undefined) {
    return backfillNullableFields(encoded.to, value);
  }
  switch (ast._tag) {
    case "Objects": {
      if (!isObject(value)) {
        return value;
      }
      const fields: [string, unknown][] = [];
      const knownKeys = new Set<string>();
      for (const property of ast.propertySignatures) {
        const key = String(property.name);
        knownKeys.add(key);
        if (Object.hasOwn(value, key)) {
          fields.push([key, backfillNullableFields(property.type, value[key])]);
        } else if (
          !SchemaAST.isOptional(SchemaAST.toEncoded(property.type)) &&
          Option.isSome(decoderFor(property.type)(null))
        ) {
          fields.push([key, null]);
        }
      }
      for (const [key, field] of Object.entries(value)) {
        if (knownKeys.has(key)) {
          continue;
        }
        let restored = field;
        for (const index of ast.indexSignatures) {
          if (Option.isSome(decoderFor(index.parameter)(key))) {
            restored = backfillNullableFields(index.type, restored);
          }
        }
        fields.push([key, restored]);
      }
      return Object.fromEntries(fields);
    }
    case "Arrays":
      if (!Array.isArray(value)) {
        return value;
      }
      return value.map((item, index) => {
        const tailStart = value.length - Math.max(0, ast.rest.length - 1);
        const element =
          ast.elements[index] ??
          (index >= tailStart ? ast.rest[index - tailStart + 1] : ast.rest[0]);
        return element === undefined
          ? item
          : backfillNullableFields(element, item);
      });
    case "Union":
      // Preserve an already valid branch before considering reconstructed ones.
      if (Option.isSome(decoderFor(ast)(value))) {
        return value;
      }
      for (const member of ast.types) {
        const restored = backfillNullableFields(member, value);
        if (Option.isSome(decoderFor(member)(restored))) {
          return restored;
        }
      }
      return value;
    case "Suspend":
      return backfillNullableFields(ast.thunk(), value);
    default:
      // Opaque JSON has no declared field names to reconstruct.
      return value;
  }
};

export const encodeCustomObjectValue = (value: unknown): unknown => {
  if (!isObject(value)) {
    return value;
  }
  const nullFields: string[][] = [];
  const collect = (current: unknown, path: string[]): void => {
    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) {
        collect(item, [...path, String(index)]);
      }
    } else if (isObject(current)) {
      for (const [key, field] of Object.entries(current)) {
        const fieldPath = [...path, key];
        if (field === null) {
          nullFields.push(fieldPath);
        } else {
          collect(field, fieldPath);
        }
      }
    }
  };
  collect(value, []);
  return nullFields.length === 0 ? value : { ...value, nullFields };
};

const invalidNullFields = () =>
  new Schema.SchemaError(
    new SchemaIssue.InvalidValue({
      message: "Invalid migration store null field metadata",
    })
  );

const restoreRecordedNulls = (
  value: unknown
): Effect.Effect<unknown, Schema.SchemaError> => {
  if (!(isObject(value) && Object.hasOwn(value, "nullFields"))) {
    return Effect.succeed(value);
  }
  return Effect.gen(function* () {
    const paths = yield* Schema.decodeUnknownEffect(NullFields)(
      value.nullFields
    );
    const restored = structuredClone(value);
    for (const path of paths) {
      let parent: unknown = restored;
      for (const key of path.slice(0, -1)) {
        if (
          typeof parent !== "object" ||
          parent === null ||
          !Object.hasOwn(parent, key)
        ) {
          return yield* invalidNullFields();
        }
        parent = Reflect.get(parent, key);
      }
      const key = path.at(-1);
      if (key === undefined || !isObject(parent) || path[0] === "nullFields") {
        return yield* invalidNullFields();
      }
      if (Object.hasOwn(parent, key) && parent[key] !== null) {
        return yield* invalidNullFields();
      }
      Object.defineProperty(parent, key, {
        value: null,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return restored;
  });
};

/** Recover provider-omitted nulls, then decode against the unchanged domain codec. */
export const decodeCustomObjectValue = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown
): Effect.Effect<A, Schema.SchemaError> =>
  restoreRecordedNulls(value).pipe(
    Effect.flatMap((restored) =>
      Schema.decodeUnknownEffect(schema)(restored).pipe(
        Effect.catch(() =>
          Schema.decodeUnknownEffect(schema)(
            backfillNullableFields(schema.ast, restored)
          )
        )
      )
    )
  );
