import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SourceIdentity } from "./ids.ts";

describe("SourceIdentity", () => {
  it("keeps source identity key schemas scalar at type level", () => {
    const assertSourceIdentityTypeSafety = () => {
      // @ts-expect-error source identity scalar keys must encode as primitive values.
      SourceIdentity.key("object", Schema.Struct({ id: Schema.String }));

      // @ts-expect-error source identity tuple parts must encode as primitive values.
      SourceIdentity.part("object", Schema.Struct({ id: Schema.String }));
    };

    expect(assertSourceIdentityTypeSafety).toBeDefined();
  });

  it("rejects raw struct schemas as source identity contracts", () => {
    expect(() =>
      SourceIdentity.make({
        id: "object@v1",
        // @ts-expect-error Source identity schemas must be built with SourceIdentity.key or SourceIdentity.tuple.
        schema: Schema.Struct({ id: Schema.String }),
      })
    ).toThrow(
      "Source identity schema must be built with SourceIdentity.key or SourceIdentity.tuple"
    );
  });

  it("keeps helper-built source identity schemas as Effect schemas", () => {
    const definition = SourceIdentity.make({
      id: "article@v1",
      schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
    });

    expect(Schema.decodeUnknownSync(definition.schema)("article-1")).toBe(
      "article-1"
    );
    expect(definition.kind).toBe("scalar");
    expect(definition.parts.map((part) => part.name)).toEqual(["articleId"]);
  });

  it("rejects unnamed source identity tuple parts", () => {
    expect(() =>
      SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("", Schema.Number),
      ])
    ).toThrow("Source identity part name must not be empty");
  });

  it("rejects hand-rolled source identity tuple parts", () => {
    expect(() =>
      SourceIdentity.tuple([
        // @ts-expect-error Source identity tuple parts must be built with SourceIdentity.part.
        Schema.String,
      ])
    ).toThrow(
      "Source identity tuple parts must be built with SourceIdentity.part"
    );
  });

  it("rejects nested source identity key parts", () => {
    expect(() =>
      SourceIdentity.part(
        "object",
        // @ts-expect-error Source identity parts must decode to scalar key values.
        Schema.Struct({ id: Schema.String })
      )
    ).toThrow(
      "Source identity part object must decode to a string, number, or boolean"
    );
  });

  it("rejects optional source identity tuple parts", () => {
    expect(() =>
      SourceIdentity.part("addressIndex", Schema.optionalKey(Schema.Number))
    ).toThrow(
      "Source identity part addressIndex must decode to a string, number, or boolean"
    );
  });

  it("rejects raw tuple schemas with rest elements as source identity contracts", () => {
    expect(() =>
      SourceIdentity.make({
        id: "raw-rest@v1",
        // @ts-expect-error Source identity tuple schemas must be built with SourceIdentity.tuple.
        schema: Schema.TupleWithRest(Schema.Tuple([Schema.String]), [
          Schema.Number,
        ]),
      })
    ).toThrow(
      "Source identity schema must be built with SourceIdentity.key or SourceIdentity.tuple"
    );
  });

  it("round-trips string scalar keys", () => {
    const definition = SourceIdentity.make({
      id: "article@v1",
      schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
    });

    const identity = SourceIdentity.fromKey(definition, "article-1");
    const decoded = SourceIdentity.fromEncoded(definition, identity.encoded);

    expect(identity.encoded).toBe("article-1");
    expect(decoded.key).toBe("article-1");
  });

  it("round-trips non-string scalar keys from encoded text", () => {
    const definition = SourceIdentity.make({
      id: "post@v1",
      schema: SourceIdentity.key("postId", Schema.Number),
    });

    const identity = SourceIdentity.fromKey(definition, 42);
    const decoded = SourceIdentity.fromEncoded(definition, identity.encoded);

    expect(identity.encoded).toBe("42");
    expect(decoded.key).toBe(42);
  });

  it("round-trips scalar codecs from decoded keys through encoded identities", () => {
    const definition = SourceIdentity.make({
      id: "post@v1",
      schema: SourceIdentity.key("postId", Schema.NumberFromString),
    });

    const identity = SourceIdentity.fromKey(definition, 42);
    const decoded = SourceIdentity.fromEncoded(definition, identity.encoded);
    const parsed = SourceIdentity.fromText(definition, "42");

    expect(identity.key).toBe(42);
    expect(identity.encoded).toBe("42");
    expect(decoded.key).toBe(42);
    expect(parsed.key).toBe(42);
    expect(parsed.encoded).toBe("42");
  });

  it("parses scalar source identity targets from operator text", () => {
    const definition = SourceIdentity.make({
      id: "post@v1",
      schema: SourceIdentity.key("postId", Schema.Number),
    });

    const identity = SourceIdentity.fromText(definition, "42");

    expect(identity.key).toBe(42);
    expect(identity.encoded).toBe("42");
  });

  it("parses tuple source identity targets from positional operator text", () => {
    const definition = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("addressIndex", Schema.Number),
      ]),
    });

    const identity = SourceIdentity.fromText(definition, "bu-1:2");

    expect(identity.key).toEqual(["bu-1", 2]);
    expect(identity.encoded).toBe(JSON.stringify(["bu-1", 2]));
  });

  it("round-trips tuple codecs through encoded tuple identities", () => {
    const definition = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("addressIndex", Schema.NumberFromString),
      ]),
    });

    const identity = SourceIdentity.fromKey(definition, ["bu-1", 2]);
    const decoded = SourceIdentity.fromEncoded(definition, identity.encoded);
    const parsed = SourceIdentity.fromText(definition, "bu-1:2");

    expect(identity.key).toEqual(["bu-1", 2]);
    expect(identity.encoded).toBe(JSON.stringify(["bu-1", "2"]));
    expect(decoded.key).toEqual(["bu-1", 2]);
    expect(parsed.key).toEqual(["bu-1", 2]);
    expect(parsed.encoded).toBe(JSON.stringify(["bu-1", "2"]));
  });

  it("canonicalizes decoded tuple source identities", () => {
    const definition = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("addressIndex", Schema.Number),
      ]),
    });

    const identity = SourceIdentity.fromEncoded(definition, '["bu-1", 2]');

    expect(identity.key).toEqual(["bu-1", 2]);
    expect(identity.encoded).toBe(JSON.stringify(["bu-1", 2]));
  });

  it("parses escaped tuple source identity parts from operator text", () => {
    const definition = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("addressIndex", Schema.Number),
      ]),
    });

    const identity = SourceIdentity.fromText(definition, "bu%3Awest:2");

    expect(identity.key).toEqual(["bu:west", 2]);
    expect(identity.encoded).toBe(JSON.stringify(["bu:west", 2]));
  });

  it("includes supported schema shape in the contract fingerprint", () => {
    const stringDefinition = SourceIdentity.make({
      id: "post@v1",
      schema: SourceIdentity.key("postId", Schema.NonEmptyString),
    });
    const numberDefinition = SourceIdentity.make({
      id: "post@v1",
      schema: SourceIdentity.key("postId", Schema.Number),
    });

    expect(stringDefinition.fingerprint).not.toBe(numberDefinition.fingerprint);
  });

  it("includes tuple part positions in the contract fingerprint", () => {
    const businessAddress = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("addressKey", Schema.NonEmptyString),
      ]),
    });
    const addressBusiness = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("addressKey", Schema.NonEmptyString),
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
      ]),
    });

    expect(businessAddress.fingerprint).not.toBe(addressBusiness.fingerprint);
  });

  it("includes tuple part names in the contract fingerprint", () => {
    const businessAddress = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("businessUnitKey", Schema.NonEmptyString),
        SourceIdentity.part("addressKey", Schema.NonEmptyString),
      ]),
    });
    const customerAddress = SourceIdentity.make({
      id: "business-address@v1",
      schema: SourceIdentity.tuple([
        SourceIdentity.part("customerKey", Schema.NonEmptyString),
        SourceIdentity.part("addressKey", Schema.NonEmptyString),
      ]),
    });

    expect(businessAddress.fingerprint).not.toBe(customerAddress.fingerprint);
  });
});
