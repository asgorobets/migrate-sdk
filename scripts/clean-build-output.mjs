import { rm } from "node:fs/promises";

const paths = process.argv.slice(2);

if (paths.length === 0) {
  throw new Error("Usage: clean-build-output.mjs <path>...");
}

await Promise.all(
  paths.map((path) => rm(path, { force: true, recursive: true }))
);
