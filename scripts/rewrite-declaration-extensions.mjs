import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [distDirectory] = process.argv.slice(2);

if (!distDirectory) {
  throw new Error("Usage: rewrite-declaration-extensions.mjs <dist-directory>");
}

const declarationFilePattern = /\.d\.ts$/u;
const relativeTypescriptSpecifierPattern =
  /((?:from\s+|import\s*\(\s*)["'])(\.{1,2}\/[^"']+)\.ts(["'])/gu;

const rewriteFile = async (path) => {
  const content = await readFile(path, "utf8");
  const rewritten = content.replace(
    relativeTypescriptSpecifierPattern,
    "$1$2.js$3"
  );

  if (rewritten !== content) {
    await writeFile(path, rewritten);
  }
};

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }

    if (entry.isFile() && declarationFilePattern.test(entry.name)) {
      await rewriteFile(path);
    }
  }
};

await walk(distDirectory);
