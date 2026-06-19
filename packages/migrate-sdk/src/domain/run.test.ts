import { describe, expect, it } from "@effect/vitest";
import { makeEncodedRunRequest, makeRunRequest } from "./run.ts";

describe("RunRequest", () => {
  it("preserves update intent for raw run requests", () => {
    const definitions = [] as const;

    expect(makeRunRequest({ definitions, update: true })).toEqual({
      definitions,
      update: true,
    });
    expect(makeEncodedRunRequest({ definitions, update: true })).toEqual({
      definitions,
      update: true,
    });
  });
});
