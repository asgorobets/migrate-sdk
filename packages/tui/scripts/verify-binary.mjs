/** Reject mislabeled build artifacts before they enter platform packages. */
export function verifyBinary(bytes, target) {
  const expectedArm64 = target.arch === "arm64";
  let matches = false;
  if (bytes.length >= 64) {
    if (target.platform === "darwin") {
      matches =
        bytes.readUInt32LE(0) === 0xfe_ed_fa_cf &&
        bytes.readUInt32LE(4) ===
          (expectedArm64 ? 0x01_00_00_0c : 0x01_00_00_07);
    } else if (target.platform === "linux") {
      matches =
        bytes.subarray(0, 4).toString("hex") === "7f454c46" &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        bytes.readUInt16LE(18) === (expectedArm64 ? 183 : 62);
    } else if (target.platform === "win32") {
      const header = bytes.readUInt32LE(0x3c);
      matches =
        bytes.readUInt16LE(0) === 0x5a_4d &&
        header >= 64 &&
        header + 6 <= bytes.length &&
        bytes.readUInt32LE(header) === 0x00_00_45_50 &&
        bytes.readUInt16LE(header + 4) === (expectedArm64 ? 0xaa_64 : 0x86_64);
    }
  }
  if (!matches) {
    throw new Error(
      `Executable format/architecture does not match ${target.id}`
    );
  }
}
