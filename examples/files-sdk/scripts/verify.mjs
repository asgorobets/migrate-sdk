import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../.data/source/", import.meta.url));
const destination = fileURLToPath(
  new URL("../.data/destination/copied/", import.meta.url)
);
let count = 0;

for (const key of await readdir(source, { recursive: true })) {
  if (!(await stat(join(source, key))).isFile()) {
    continue;
  }
  const expected = await readFile(join(source, key));
  const actual = await readFile(join(destination, key));
  assert.deepEqual(actual, expected, `Copied bytes differ: ${key}`);
  count += 1;
}

assert.ok(count > 0, "Run pnpm run setup before migrating.");
console.log(`Verified ${count} files: destination bytes match the source.`);
