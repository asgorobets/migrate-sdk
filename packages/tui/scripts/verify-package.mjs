import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageDirectory = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8")
);

const requiredFiles = [
  "bin/migrate-tui.js",
  "dist/bin.js",
  "dist/server/node-entry.js",
];

for (const path of requiredFiles) {
  await access(resolve(packageDirectory, path), constants.R_OK);
}

if (packageJson.bin?.["migrate-tui"] !== "./bin/migrate-tui.js") {
  throw new Error("package.json must expose the Node launcher as migrate-tui");
}

if (packageJson.dependencies?.bun === undefined) {
  throw new Error("package.json must provide Bun as a runtime dependency");
}

if (
  packageJson.peerDependencies?.effect === undefined ||
  packageJson.peerDependencies?.["migrate-sdk"] === undefined
) {
  throw new Error(
    "effect and migrate-sdk must remain runtime peer dependencies"
  );
}

process.stdout.write("Migrate TUI package contents verified\n");
