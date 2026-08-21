import { describe, expect, it } from "@effect/vitest";
import { expectTypeOf } from "vitest";
import {
  type ExecutionStartResult,
  type MigrationRunHandle,
  makeRunRequest,
} from "./run.ts";

type AttachedStart = Extract<
  ExecutionStartResult,
  {
    readonly handle: MigrationRunHandle;
    readonly kind: "started";
  }
>;

type DetachedStart = Extract<
  ExecutionStartResult,
  {
    readonly handle?: undefined;
    readonly kind: "started";
  }
>;

describe("RunRequest", () => {
  it("preserves update intent for raw run requests", () => {
    const definitions = [] as const;

    expect(makeRunRequest({ definitions, update: true })).toEqual({
      definitions,
      update: true,
    });
  });

  it("preserves rescan intent for raw run requests", () => {
    const definitions = [] as const;

    expect(makeRunRequest({ definitions, rescan: true })).toEqual({
      definitions,
      rescan: true,
    });
  });
});

describe("ExecutionStartResult", () => {
  it("requires execution identity only for detached starts", () => {
    expectTypeOf<AttachedStart["execution"]["executionId"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      DetachedStart["execution"]["executionId"]
    >().toEqualTypeOf<string>();
  });
});
