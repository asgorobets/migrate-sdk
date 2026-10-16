import { describe, expect, it } from "vitest";
import {
  binaryTargets,
  findBinaryTarget,
  hostBinaryTarget,
} from "../bin/binary-targets.js";

describe("binary target selection", () => {
  it("selects the Linux ABI without crossing libc families", () => {
    expect(
      hostBinaryTarget({ platform: "linux", arch: "x64", libc: "glibc" })
        .packageName
    ).toBe("@migrate-sdk/tui-linux-x64-glibc");
    expect(
      hostBinaryTarget({ platform: "linux", arch: "x64", libc: "musl" })
        .compileTarget
    ).toBe("bun-linux-x64-musl-baseline");
  });
  it("uses the same target for build flags and runtime package selection", () => {
    for (const target of binaryTargets) {
      expect(findBinaryTarget(target.compileTarget)).toEqual(
        hostBinaryTarget(target)
      );
      if (target.arch === "x64") {
        expect(target.compileTarget).toContain("baseline");
      }
    }
  });
  it("rejects unsupported targets rather than silently building for the host", () => {
    expect(() => findBinaryTarget("bun-linux-x46")).toThrow(
      "Unknown binary target"
    );
    expect(() =>
      hostBinaryTarget({ platform: "freebsd", arch: "x64" })
    ).toThrow("Unsupported platform");
  });
});
