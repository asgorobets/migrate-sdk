const platforms = [
  ["darwin", "arm64"],
  ["darwin", "x64"],
  ["linux", "arm64", "glibc"],
  ["linux", "x64", "glibc"],
  ["win32", "x64"],
  ["linux", "arm64", "musl"],
  ["linux", "x64", "musl"],
  ["win32", "arm64"],
];

// One baseline x64 build per OS/libc: Bun 1.3.14's modern runtime needs AVX2.
export const binaryTargets = platforms.map(([platform, arch, libc]) => {
  const os = platform === "win32" ? "windows" : platform;
  const id = [os, arch, libc].filter(Boolean).join("-");
  return {
    id,
    platform,
    arch,
    libc,
    compileTarget: [
      "bun",
      os,
      arch,
      ...(libc === "musl" ? ["musl"] : []),
      ...(arch === "x64" ? ["baseline"] : []),
    ].join("-"),
    executable: platform === "win32" ? "migrate-tui.exe" : "migrate-tui",
    packageName: `@migrate-sdk/tui-${id}`,
    nativePackage: `@opentui/core-${platform}-${arch}${libc === "musl" ? "-musl" : ""}`,
  };
});

export const linuxLibc = (report = process.report?.getReport()) => {
  if (typeof report !== "object" || report === null || !report.header) {
    throw new Error("Unable to detect Linux libc for Migrate TUI");
  }
  return report.header.glibcVersionRuntime ? "glibc" : "musl";
};

export const hostBinaryTarget = ({
  platform = process.platform,
  arch = process.arch,
  libc,
} = {}) => {
  const hostLibc = platform === "linux" ? (libc ?? linuxLibc()) : undefined;
  const target = binaryTargets.find(
    (item) =>
      item.platform === platform && item.arch === arch && item.libc === hostLibc
  );
  if (!target) {
    throw new Error(
      `Unsupported platform for Migrate TUI: ${platform}-${arch}`
    );
  }
  return target;
};

export const findBinaryTarget = (input) => {
  const target = binaryTargets.find(
    (item) => item.id === input || item.compileTarget === input
  );
  if (!target) {
    throw new Error(
      `Unknown binary target: ${input}. Choose ${binaryTargets.map((item) => item.id).join(", ")}`
    );
  }
  return target;
};
