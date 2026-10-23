import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema, SchemaGetter } from "effect";
import {
  decodeCustomObjectValue,
  encodeCustomObjectValue,
} from "./custom-object-value.ts";

const decode = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  value: unknown
) => Effect.runSync(decodeCustomObjectValue(schema, value));

// Model the provider response without sharing the recorder's implementation.
const persisted = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(
      encodeCustomObjectValue(value),
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
        '{"a.b":null,"a/b":null,"":null,"__proto__":null,"constructor":null,"array":[null,{"nested":null}]}'
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

  it("does not add metadata to records without null object fields", () => {
    expect(
      encodeCustomObjectValue({ state: { cursor: "saved", values: [null] } })
    ).toEqual({
      state: { cursor: "saved", values: [null] },
    });
  });

  it("rejects malformed null metadata and refuses to overwrite existing values", () => {
    const schema = Schema.Struct({ payload: Schema.Json });
    for (const nullFields of [
      "wrong",
      [[]],
      [["payload", "missing-parent", "key"]],
      [["payload", "present"]],
      [["nullFields"]],
    ]) {
      expect(() =>
        decode(schema, { payload: { present: "preserved" }, nullFields })
      ).toThrow();
    }
    expect(() =>
      decode(Schema.Struct({ required: Schema.String }), {
        nullFields: [["required"]],
      })
    ).toThrow();
  });
});
