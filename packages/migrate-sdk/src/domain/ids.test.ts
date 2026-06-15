import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SourceIdentity } from "./ids.ts";

describe("SourceIdentity", () => {
  // @ts-expect-error source identity scalar keys must encode as primitive values.
  SourceIdentity.key("object", Schema.Struct({ id: Schema.String }));

  // @ts-expect-error source identity tuple parts must encode as primitive values.
  SourceIdentity.part("object", Schema.Struct({ id: Schema.String }));

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
});
