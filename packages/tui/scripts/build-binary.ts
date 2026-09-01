#!/usr/bin/env bun

import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { build } from "bun";

const packageDirectory = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8")
) as { readonly version: string };
const targetFlagIndex = process.argv.indexOf("--target");
const targetInput =
  targetFlagIndex === -1 ? undefined : process.argv[targetFlagIndex + 1];

if (targetFlagIndex !== -1 && targetInput === undefined) {
  throw new Error("--target requires a Bun compile target");
}

const target = targetInput as Bun.Build.CompileTarget | undefined;
const windows =
  target?.startsWith("bun-windows-") ?? process.platform === "win32";
const outputPath = resolve(
  packageDirectory,
  "dist",
  "binary",
  windows ? "migrate-tui.exe" : "migrate-tui"
);

await mkdir(dirname(outputPath), { recursive: true });

const result = await build({
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadPackageJson: true,
    autoloadTsconfig: true,
    outfile: outputPath,
    ...(target === undefined ? {} : { target }),
  },
  conditions: ["bun", "node"],
  define: {
    MIGRATE_TUI_VERSION: JSON.stringify(packageJson.version),
  },
  entrypoints: [resolve(packageDirectory, "src/bin.tsx")],
  external: ["effect", "migrate-sdk"],
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

console.log(`Built ${basename(outputPath)} ${packageJson.version}`);
console.log(outputPath);
