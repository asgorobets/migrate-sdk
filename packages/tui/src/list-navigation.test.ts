import { describe, expect, it } from "vitest";
import { nextListSelection } from "./list-navigation.ts";

describe("nextListSelection", () => {
  it("moves, jumps, and clamps within the list", () => {
    expect(nextListSelection("down", 2, 5)).toBe(3);
    expect(nextListSelection("k", 2, 5)).toBe(1);
    expect(nextListSelection("pagedown", 2, 20)).toBe(12);
    expect(nextListSelection("pageup", 2, 20)).toBe(0);
    expect(nextListSelection("home", 4, 5)).toBe(0);
    expect(nextListSelection("end", 0, 5)).toBe(4);
  });

  it("ignores non-navigation keys and handles an empty list", () => {
    expect(nextListSelection("return", 2, 5)).toBeUndefined();
    expect(nextListSelection("end", 0, 0)).toBe(0);
  });
});
