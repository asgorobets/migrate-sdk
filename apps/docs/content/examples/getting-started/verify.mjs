import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Keep temporary scripts beside node_modules so they resolve the installed SDK.
const directory = await mkdtemp(join(root, ".verify-"));

function run(command = "run") {
  const output = execFileSync(process.execPath, ["run.ts", command], {
    cwd: directory,
    encoding: "utf8",
    timeout: 30_000,
  });
  const summary = JSON.parse(output);
  assert.equal(summary.status, "succeeded", output);
  const definition = summary.definitions.find(
    (entry) => entry.definitionId === "authors"
  );
  assert.ok(definition, output);
  assert.equal(definition.counts.failed, 0, output);
  return definition.counts;
}

async function readAuthor() {
  return JSON.parse(
    await readFile(join(directory, "authors/author-1.json"), "utf8")
  );
}

try {
  for (const name of [
    "package.json",
    "source.ts",
    "destination.ts",
    "migration.ts",
    "run.ts",
  ]) {
    await copyFile(join(root, name), join(directory, name));
  }

  assert.equal(run().migrated, 2);
  assert.deepEqual(await readAuthor(), { id: "author-1", name: "Ada Morgan" });
  console.log("PASS: first run writes two author files");

  const unchanged = run();
  assert.equal(unchanged.migrated, 0);
  assert.equal(unchanged.unchanged, 2);
  console.log("PASS: a separate process reuses saved progress");

  const sourcePath = join(directory, "source.ts");
  const source = await readFile(sourcePath, "utf8");
  assert.ok(source.includes('lastName: "Morgan"'));
  await writeFile(
    sourcePath,
    source.replace('lastName: "Morgan"', 'lastName: "Lovelace"')
  );
  const changed = run();
  assert.equal(changed.migrated, 1);
  assert.equal(changed.unchanged, 1);
  assert.equal((await readAuthor()).name, "Ada Lovelace");
  console.log("PASS: changing a source record updates only that author");

  assert.equal(run("update").migrated, 2);
  console.log("PASS: explicit update reprocesses both authors");

  assert.equal(run("rollback").rolledBack, 2);
  assert.deepEqual(await readdir(join(directory, "authors")), []);
  console.log("PASS: rollback removes both destination files");

  assert.equal(run().migrated, 2);
  console.log("PASS: both authors can migrate again after rollback");
  console.log(`Verified with ${process.version}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
