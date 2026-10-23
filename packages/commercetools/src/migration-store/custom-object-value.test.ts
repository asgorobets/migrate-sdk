import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaGetter } from "effect";
import { customObjectCodec } from "./custom-object-value.ts";

const decode = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown
) => Schema.decodeUnknownSync(customObjectCodec(schema))(value);

// Model the provider response without sharing the recorder's implementation.
const persisted = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(
      Schema.encodeUnknownSync(customObjectCodec(Schema.Unknown))(value),
      function (key, field: unknown) {
        return key !== "" && field === null && !Array.isArray(this)
          ? undefined
          : field;
      }
    )
  );

describe("Custom Object null compatibility", () => {
  it("restores schema-declared nulls throughout nested structures", () => {
    const Row = Schema.Struct({ label: Schema.NullOr(Schema.String) });
    const schema = Schema.Struct({
      root: Schema.NullOr(Schema.String),
      rows: Schema.Array(Row),
      tuple: Schema.Tuple([Row, Schema.String]),
      records: Schema.Record(Schema.String, Row),
      choice: Schema.Union([
        Schema.Struct({
          kind: Schema.Literal("first"),
          cursor: Schema.NullOr(Schema.String),
        }),
        Schema.Struct({
          kind: Schema.Literal("second"),
          year: Schema.NullOr(Schema.Finite),
        }),
      ]),
    });
    const input = {
      rows: [{}],
      tuple: [{}, "tail"],
      records: { a: {} },
      choice: { kind: "second" },
    };
    expect(decode(schema, input)).toEqual({
      root: null,
      rows: [{ label: null }],
      tuple: [{ label: null }, "tail"],
      records: { a: { label: null } },
      choice: { kind: "second", year: null },
    });
    expect(() => Schema.decodeUnknownSync(schema)(input)).toThrow();
    expect(input.rows).toEqual([{}]);
  });

  it("preserves optional absence and existing decoding defaults", () => {
    const schema = Schema.Struct({
      optional: Schema.optionalKey(Schema.NullOr(Schema.String)),
      fallback: Schema.NullOr(Schema.String).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("configured-default"))
      ),
      unknown: Schema.Json,
    });
    expect(decode(schema, { unknown: {} })).toEqual({
      fallback: "configured-default",
      unknown: {},
    });
    expect(decode(schema, { unknown: {}, optional: null })).toEqual({
      optional: null,
      fallback: "configured-default",
      unknown: {},
    });
  });

  it("uses encoded property names and preserves decoded transformations", () => {
    const schema = Schema.Struct({
      storedCursor: Schema.NullOr(Schema.String),
    }).pipe(
      Schema.decodeTo(Schema.Struct({ cursor: Schema.NullOr(Schema.String) }), {
        decode: SchemaGetter.transform(({ storedCursor }) => ({
          cursor: storedCursor,
        })),
        encode: SchemaGetter.transform(({ cursor }) => ({
          storedCursor: cursor,
        })),
      })
    );
    expect(decode(schema, {})).toEqual({ cursor: null });
    expect(decode(schema, { storedCursor: "saved" })).toEqual({
      cursor: "saved",
    });
    const numeric = Schema.Struct({
      count: Schema.NullOr(Schema.FiniteFromString),
      at: Schema.DateFromString,
    });
    expect(
      decode(numeric, { count: "42", at: "2026-10-23T00:00:00.000Z" })
    ).toEqual({
      count: 42,
      at: new Date("2026-10-23T00:00:00.000Z"),
    });
  });

  it("respects decoded refinements when choosing union branches", () => {
    const First = Schema.Struct({
      value: Schema.FiniteFromString,
      first: Schema.NullOr(Schema.String),
    }).check(Schema.makeFilter(({ value }) => value < 0));
    const Second = Schema.Struct({
      value: Schema.FiniteFromString,
      second: Schema.NullOr(Schema.String),
    });
    expect(decode(Schema.Union([First, Second]), { value: "1" })).toEqual({
      value: 1,
      second: null,
    });
  });

  it("handles recursive field schemas", () => {
    interface Node {
      readonly children: readonly Node[];
      readonly label: string | null;
    }
    const NodeSchema: Schema.Codec<Node> = Schema.suspend(() =>
      Schema.Struct({
        label: Schema.NullOr(Schema.String),
        children: Schema.Array(NodeSchema),
      })
    );
    expect(decode(NodeSchema, { children: [{ children: [] }] })).toEqual({
      label: null,
      children: [{ label: null, children: [] }],
    });
  });

  it("does not repair invalid values, missing non-nullable fields, or rejected nulls", () => {
    const schema = Schema.Struct({
      cursor: Schema.NullOr(Schema.String),
      required: Schema.String,
    });
    for (const input of [
      { cursor: 123, required: "present" },
      { cursor: null },
      { required: null },
    ]) {
      expect(() => decode(schema, input)).toThrow();
    }
    const noNull = Schema.Struct({
      cursor: Schema.NullOr(Schema.String).check(
        Schema.makeFilter((cursor) => cursor !== null)
      ),
    });
    expect(() => decode(noNull, {})).toThrow();
  });

  it("round-trips arbitrary JSON nulls with unusual keys and array positions", () => {
    const schema = Schema.Struct({ payload: Schema.Json });
    const original = {
      payload: JSON.parse(
        '{"a.b":null,"a/b":null,"":null,"__proto__":null,"constructor":null,"nullFields":null,"array":[null,{"nested":null}]}'
      ),
    };
    const stored = persisted(original);
    expect(decode(schema, stored)).toEqual(original);
    expect(
      Object.hasOwn(decode(schema, stored).payload as object, "__proto__")
    ).toBe(true);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("does not infer unknown JSON fields in old records without null metadata", () => {
    expect(
      decode(Schema.Struct({ payload: Schema.Json }), { payload: {} })
    ).toEqual({ payload: {} });
  });

  it("marks new records even when there are no nulls to restore", () => {
    const schema = Schema.Struct({ cursor: Schema.String });
    const encoded = Schema.encodeUnknownSync(customObjectCodec(schema))({
      cursor: "saved",
    });
    expect(encoded).toEqual({ cursor: "saved", nullFields: [] });
    expect(decode(schema, encoded)).toEqual({ cursor: "saved" });
  });

  it("decodes missing nullable keys without replaying domain transformations", () => {
    let calls = 0;
    const name = Schema.String.pipe(
      Schema.decodeTo(Schema.String, {
        decode: SchemaGetter.transform((value) => {
          calls += 1;
          return value;
        }),
        encode: SchemaGetter.passthrough(),
      })
    );
    const schema = Schema.Struct({
      name,
      cursor: Schema.NullOr(Schema.String),
    });
    const codec = customObjectCodec(schema);
    expect(Schema.decodeUnknownSync(codec)({ name: "record" })).toEqual({
      name: "record",
      cursor: null,
    });
    expect(calls).toBe(1);
  });

  it("preserves optional absence, optional nulls and already-valid union branches", () => {
    const schema = Schema.Struct({
      choice: Schema.Union([
        Schema.Struct({ required: Schema.NullOr(Schema.String) }),
        Schema.Struct({ name: Schema.String }),
      ]),
      optional: Schema.optionalKey(Schema.NullOr(Schema.String)),
    });
    for (const value of [
      { choice: { name: "second" } },
      { choice: { name: "second" }, optional: null },
      { choice: { required: null } },
    ]) {
      expect(decode(schema, persisted(value))).toEqual(value);
    }
  });

  it("writes null-free provider values without changing the supplied value", () => {
    const schema = Schema.Struct({ payload: Schema.Json });
    const value = {
      payload: {
        nullable: null,
        nested: [null, { nullable: null }, 0, "null"],
      },
    };
    const encoded = Schema.encodeUnknownSync(customObjectCodec(schema))(value);
    const containsNull = (input: unknown): boolean => {
      if (input === null) {
        return true;
      }
      if (Array.isArray(input)) {
        return input.some(containsNull);
      }
      return typeof input === "object" && input !== null
        ? Object.values(input).some(containsNull)
        : false;
    };
    expect(containsNull(encoded)).toBe(false);
    expect(decode(schema, encoded)).toEqual(value);
    expect(value.payload.nullable).toBeNull();
    expect(value.payload.nested[0]).toBeNull();
  });

  it("preserves transformations and parent refinements in both storage representations", () => {
    const schema = Schema.Struct({
      id: Schema.String,
      at: Schema.DateFromString,
      cursor: Schema.NullOr(Schema.String),
    }).check(Schema.makeFilter(({ id }) => id !== "rejected"));
    const codec = customObjectCodec(schema);
    const value = {
      id: "record",
      at: new Date("2026-10-23T00:00:00Z"),
      cursor: null,
    };
    const encoded = Schema.encodeUnknownSync(codec)(value);
    expect(Schema.decodeUnknownSync(codec)(encoded)).toEqual(value);
    expect(
      decode(schema, { id: "record", at: value.at.toISOString() })
    ).toEqual(value);
    expect(() =>
      decode(schema, { id: "rejected", at: value.at.toISOString() })
    ).toThrow();
    expect(() =>
      Schema.encodeUnknownSync(codec)({ ...value, id: "rejected" })
    ).toThrow();
    expect(() =>
      Schema.encodeUnknownSync(schema)({ id: "record", at: value.at })
    ).toThrow();
    expect(() =>
      Schema.encodeUnknownSync(codec)({ id: "record", at: value.at })
    ).toThrow();
  });

  it("does not repair malformed current records or leak metadata into domain values", () => {
    const schema = Schema.Struct({ cursor: Schema.NullOr(Schema.String) });
    const invalid = Schema.decodeUnknownExit(customObjectCodec(schema))({
      nullFields: [],
    });
    expect(invalid._tag).toBe("Failure");
    expect(() => decode(schema, { nullFields: [] })).toThrow("Missing key");
    expect(
      decode(Schema.Record(Schema.String, Schema.Json), {
        payload: {},
        nullFields: [["payload", "nullable"]],
      })
    ).toEqual({ payload: { nullable: null } });
  });

  it("rejects malformed null metadata and refuses to overwrite existing values", () => {
    const schema = Schema.Struct({ payload: Schema.Json });
    for (const nullFields of [
      "wrong",
      [[]],
      [["payload", "missing-parent", "key"]],
      [["payload", "present"]],
      [["nullFields"]],
      [["payload", "array", "length"]],
      [["payload", "array", "-1"]],
      [["payload", "array", "1"]],
    ]) {
      const result = Effect.runSync(
        Effect.result(
          Schema.decodeUnknownEffect(customObjectCodec(schema))({
            payload: { present: "preserved", array: ["kept"] },
            nullFields,
          })
        )
      );
      expect(result._tag).toBe("Failure");
    }
    expect(() =>
      decode(Schema.Struct({ required: Schema.String }), {
        nullFields: [["required"]],
      })
    ).toThrow();
  });
});
