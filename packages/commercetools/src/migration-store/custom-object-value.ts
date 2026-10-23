import {
  Effect,
  Option,
  Schema,
  SchemaAST,
  SchemaGetter,
  SchemaIssue,
} from "effect";

const NullFields = Schema.Array(Schema.NonEmptyArray(Schema.String));
type JsonCodec = Schema.Codec<unknown, unknown, never, never>;
const codecs = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const nullableSchemas = new WeakMap<SchemaAST.AST, SchemaAST.AST>();
const nullArrayPlaceholder = 0;
const arrayIndexPattern = /^(0|[1-9][0-9]*)$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasNullFields = (value: unknown): boolean =>
  isObject(value) && Object.hasOwn(value, "nullFields");

// Build storage-side defaults once. The decoded fields, checks and transforms
// retain their original contract; only missing nullable input keys are accepted.
const withNullableFieldDefault = (ast: SchemaAST.AST): SchemaAST.AST => {
  const derived = Schema.make<JsonCodec>(withNullableDefaults(ast));
  if (
    SchemaAST.isOptional(SchemaAST.toEncoded(ast)) ||
    Option.isNone(Schema.decodeUnknownOption(Schema.make<JsonCodec>(ast))(null))
  ) {
    return derived.ast;
  }
  return derived.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))).ast;
};

const withNullableDefaults = (ast: SchemaAST.AST): SchemaAST.AST => {
  const cached = nullableSchemas.get(ast);
  if (cached !== undefined) {
    return cached;
  }
  let derived = ast;
  if (ast.encoding === undefined) {
    switch (ast._tag) {
      case "Objects":
        derived = new SchemaAST.Objects(
          ast.propertySignatures.map(
            (property) =>
              new SchemaAST.PropertySignature(
                property.name,
                withNullableFieldDefault(property.type)
              )
          ),
          ast.indexSignatures.map(
            (index) =>
              new SchemaAST.IndexSignature(
                index.parameter,
                withNullableDefaults(index.type)
              )
          ),
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
          ast.encodingChecks
        );
        break;
      case "Arrays":
        derived = new SchemaAST.Arrays(
          ast.isMutable,
          ast.elements.map(withNullableDefaults),
          ast.rest.map(withNullableDefaults),
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
          ast.encodingChecks
        );
        break;
      case "Union":
        derived = new SchemaAST.Union(
          ast.types.map(withNullableDefaults),
          ast.options,
          ast.annotations,
          ast.checks,
          undefined,
          ast.context,
          ast.encodingChecks
        );
        break;
      case "Suspend":
        derived = new SchemaAST.Suspend(
          () => withNullableDefaults(ast.thunk()),
          ast.annotations,
          undefined,
          undefined,
          ast.context
        );
        break;
      default:
        break;
    }
  } else {
    const [first, ...rest] = ast.encoding;
    const encoding: SchemaAST.Encoding = [
      new SchemaAST.Link(withNullableDefaults(first.to), first.transformation),
      ...rest.map(
        (link) =>
          new SchemaAST.Link(withNullableDefaults(link.to), link.transformation)
      ),
    ];
    derived = Object.assign(
      Object.create(Object.getPrototypeOf(ast)) as SchemaAST.AST,
      ast,
      { encoding }
    );
  }
  nullableSchemas.set(ast, derived);
  return derived;
};

// Metadata belongs to the provider envelope, never to user schemas. Always
// include it so reads can distinguish lossless writes from older plain records.
const recordNulls = (value: unknown): unknown => {
  if (!isObject(value)) {
    return value;
  }
  const nullFields: string[][] = [];
  const encode = (current: unknown, path: string[]): unknown => {
    if (Array.isArray(current)) {
      return current.map((item, index) => {
        const itemPath = [...path, String(index)];
        if (item === null) {
          nullFields.push(itemPath);
          return nullArrayPlaceholder;
        }
        return encode(item, itemPath);
      });
    }
    if (isObject(current)) {
      const fields: [string, unknown][] = [];
      for (const [key, field] of Object.entries(current)) {
        const fieldPath = [...path, key];
        if (field === null) {
          nullFields.push(fieldPath);
        } else {
          fields.push([key, encode(field, fieldPath)]);
        }
      }
      return Object.fromEntries(fields);
    }
    return current;
  };
  const encoded = encode(value, []);
  return isObject(encoded) ? { ...encoded, nullFields } : encoded;
};

const invalidNullFields = () =>
  new SchemaIssue.InvalidValue({
    message: "Invalid migration store null field metadata",
  });

const restoreNulls = (
  value: unknown
): Effect.Effect<unknown, SchemaIssue.Issue> =>
  Effect.gen(function* () {
    if (!isObject(value)) {
      return yield* Effect.fail(invalidNullFields());
    }
    const paths = yield* Schema.decodeUnknownEffect(NullFields)(
      value.nullFields
    ).pipe(Effect.mapError((error) => error.issue));
    const restored = structuredClone(value);
    Reflect.deleteProperty(restored, "nullFields");
    for (const path of paths) {
      let parent: unknown = restored;
      for (const key of path.slice(0, -1)) {
        if (
          typeof parent !== "object" ||
          parent === null ||
          !Object.hasOwn(parent, key)
        ) {
          return yield* Effect.fail(invalidNullFields());
        }
        parent = Reflect.get(parent, key);
      }
      const key = path.at(-1);
      if (key === undefined || path[0] === "nullFields") {
        return yield* Effect.fail(invalidNullFields());
      }
      if (Array.isArray(parent)) {
        if (
          !(arrayIndexPattern.test(key) && Object.hasOwn(parent, key)) ||
          (parent[Number(key)] !== nullArrayPlaceholder &&
            parent[Number(key)] !== null)
        ) {
          return yield* Effect.fail(invalidNullFields());
        }
      } else if (
        !isObject(parent) ||
        (Object.hasOwn(parent, key) && parent[key] !== null)
      ) {
        return yield* Effect.fail(invalidNullFields());
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

const ValueWithNullMetadata = Schema.Unknown.check(
  Schema.makeFilter(hasNullFields)
);
const ValueWithoutNullMetadata = Schema.Unknown.check(
  Schema.makeFilter((value) => !hasNullFields(value))
);

/** Private storage codec: lossless new writes and schema defaults for old records. */
export const customObjectCodec = <A>(
  schema: Schema.Codec<A, unknown, never, never>
): Schema.Codec<A, unknown, never, never> => {
  let ast = codecs.get(schema.ast);
  if (ast === undefined) {
    const withNullMetadata = ValueWithNullMetadata.pipe(
      Schema.decodeTo(schema, {
        decode: SchemaGetter.transformEffect(restoreNulls),
        encode: SchemaGetter.transform(recordNulls),
      })
    );
    const withoutNullMetadata = ValueWithoutNullMetadata.pipe(
      Schema.decodeTo(
        Schema.make<JsonCodec>(withNullableDefaults(schema.ast)),
        {
          decode: SchemaGetter.passthrough(),
          encode: SchemaGetter.forbidden(
            () => "Migration store records must use null-preserving encoding"
          ),
        }
      )
    );
    ast = Schema.Union([withNullMetadata, withoutNullMetadata]).ast;
    codecs.set(schema.ast, ast);
  }
  return Schema.make<Schema.Codec<A, unknown, never, never>>(ast);
};
