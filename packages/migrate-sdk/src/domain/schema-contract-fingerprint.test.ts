import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { makeEffectSchemaContractFingerprint } from "./schema-contract-fingerprint.ts";

describe("makeEffectSchemaContractFingerprint", () => {
  it("uses a versioned canonical representation", () => {
    expect(makeEffectSchemaContractFingerprint(Schema.String)).toBe(
      'effect-schema-representation@v1:{"references":{},"representation":{"_tag":"String","checks":[]}}'
    );
  });

  it("distinguishes different schema contracts", () => {
    expect(makeEffectSchemaContractFingerprint(Schema.String)).not.toBe(
      makeEffectSchemaContractFingerprint(Schema.Number)
    );
  });
});
