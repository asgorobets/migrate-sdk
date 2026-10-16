import { describe, expect, it } from "vitest";
import { findBinaryTarget } from "../bin/binary-targets.js";
import { verifyBinary } from "../scripts/verify-binary.mjs";

describe("binary artifact architecture verification", () => {
  it("rejects an ARM64 Mach-O renamed as x64 or Linux", () => {
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32LE(0xfe_ed_fa_cf, 0);
    bytes.writeUInt32LE(0x01_00_00_0c, 4);
    expect(() =>
      verifyBinary(bytes, findBinaryTarget("darwin-arm64"))
    ).not.toThrow();
    expect(() => verifyBinary(bytes, findBinaryTarget("darwin-x64"))).toThrow(
      "architecture"
    );
    expect(() =>
      verifyBinary(bytes, findBinaryTarget("linux-arm64-glibc"))
    ).toThrow("architecture");
  });
  it("rejects a truncated PE header without reading outside the file", () => {
    const bytes = Buffer.alloc(64);
    bytes.writeUInt16LE(0x5a_4d, 0);
    bytes.writeUInt32LE(1000, 0x3c);
    expect(() => verifyBinary(bytes, findBinaryTarget("windows-x64"))).toThrow(
      "architecture"
    );
  });
});
