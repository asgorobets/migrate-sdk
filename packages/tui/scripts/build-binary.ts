#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build, version as bunVersion, file, spawnSync } from "bun";
import {
  binaryTargets,
  findBinaryTarget,
  hostBinaryTarget,
} from "../bin/binary-targets.js";
import { verifyBinary } from "./verify-binary.mjs";

const packageDirectory = resolve(import.meta.dir, "..");
const packageJson = await file(
  resolve(packageDirectory, "package.json")
).json();
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--list-targets") {
  console.log(JSON.stringify(binaryTargets, null, 2));
  process.exit(0);
}
if (!(args.length === 0 || (args.length === 2 && args[0] === "--target"))) {
  throw new Error(
    "Usage: build-binary.ts [--target <target-id|Bun-target>] | --list-targets"
  );
}
if (bunVersion !== packageJson.dependencies.bun) {
  throw new Error(
    `Build with pinned Bun ${packageJson.dependencies.bun}; found ${bunVersion}`
  );
}
const target =
  args.length === 0 ? hostBinaryTarget() : findBinaryTarget(args[1]);
const coreRequire = createRequire(import.meta.resolve("@opentui/core"));
let nativeManifestPath: string;
try {
  coreRequire.resolve(target.nativePackage);
  nativeManifestPath = coreRequire.resolve(
    `${target.nativePackage}/package.json`
  );
} catch (cause) {
  throw new Error(
    `Missing ${target.nativePackage}@${packageJson.dependencies["@opentui/core"]} for ${target.id}. ` +
      "Build on the target OS/architecture, or provision its optional native package before cross-compiling.",
    { cause }
  );
}
const nativeManifest = await file(nativeManifestPath).json();
if (nativeManifest.version !== packageJson.dependencies["@opentui/core"]) {
  throw new Error(
    `Native OpenTUI ${nativeManifest.version} does not match pinned ${packageJson.dependencies["@opentui/core"]}`
  );
}
const outputDirectory = resolve(packageDirectory, "dist/binary", target.id);
const outputPath = resolve(outputDirectory, target.executable);
await mkdir(outputDirectory, { recursive: true });

const result = await build({
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    // Runtime package exports are needed to locate the project's Node bootstrap.
    autoloadPackageJson: true,
    autoloadTsconfig: false,
    outfile: outputPath,
    target: target.compileTarget as Bun.Build.CompileTarget,
  },
  conditions: ["bun", "node"],
  define: {
    MIGRATE_TUI_VERSION: JSON.stringify(packageJson.version),
    MIGRATE_TUI_STANDALONE: "true",
    ...(target.libc === undefined
      ? {}
      : { "process.env.OPENTUI_LIBC": JSON.stringify(target.libc) }),
  },
  entrypoints: [resolve(packageDirectory, "src/bin.tsx")],
  format: "esm",
  minify: true,
  sourcemap: "linked",
});
if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}
const bytes = await readFile(outputPath);
verifyBinary(bytes, target);
await writeFile(
  resolve(outputDirectory, "build.json"),
  `${JSON.stringify(
    {
      target: target.id,
      compileTarget: target.compileTarget,
      version: packageJson.version,
      bun: bunVersion,
      opentui: packageJson.dependencies["@opentui/core"],
      revision: spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: packageDirectory,
      })
        .stdout.toString()
        .trim(),
      executable: target.executable,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    null,
    2
  )}\n`
);
console.log(`Built ${target.id} ${packageJson.version}: ${outputPath}`);
