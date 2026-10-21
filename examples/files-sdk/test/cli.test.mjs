import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  cp,
  mkdtemp,
  readdir,
  rm,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const sdk = require("migrate-sdk/package.json");
const bin = resolve(
  dirname(require.resolve("migrate-sdk/package.json")),
  sdk.bin.migrate
);
const whitespacePattern = /\s+/gu;

function assertOutput(output, expected) {
  assert.ok(output.replace(whitespacePattern, " ").includes(expected), output);
}

test("CLI copies, skips unchanged, rescans changes, and rolls back", {
  timeout: 60_000,
}, async () => {
  const project = await mkdtemp(join(tmpdir(), "migrate-files-example-"));
  try {
    await cp(root, project, {
      recursive: true,
      filter: (path) =>
        !["node_modules", ".data", "test"].includes(basename(path)),
    });
    await symlink(
      join(root, "node_modules"),
      join(project, "node_modules"),
      "junction"
    );
    const node = (args) =>
      exec(process.execPath, args, { cwd: project, timeout: 15_000 });
    const migrate = async (...args) => {
      const result = await node([
        bin,
        "--config",
        "./migrate.config.ts",
        ...args,
      ]);
      return result.stdout;
    };

    await node(["scripts/setup.mjs"]);
    assertOutput(await migrate("list"), "folder-copy");
    assertOutput(await migrate("run", "folder-copy", "--plan"), "Run Plan");
    const first = await migrate("run", "folder-copy", "--progress", "none");
    assertOutput(first, "folder-copy succeeded 4 0 0 0 0");
    await node(["scripts/verify.mjs"]);

    const second = await migrate("run", "folder-copy", "--progress", "none");
    assertOutput(second, "folder-copy succeeded 0 4 0 0 0");
    const status = await migrate("status", "folder-copy");
    assertOutput(status, "folder-copy full complete run succeeded clear 4");

    await appendFile(
      join(project, ".data/source/hello.txt"),
      "A changed source file.\n"
    );
    const updated = await migrate(
      "run",
      "folder-copy",
      "--rescan",
      "--progress",
      "none"
    );
    assertOutput(updated, "folder-copy succeeded 1 3 0 0 0");
    await node(["scripts/verify.mjs"]);

    assertOutput(
      await migrate("rollback", "folder-copy", "--plan"),
      "Rollback Plan"
    );
    const rollback = await migrate(
      "rollback",
      "folder-copy",
      "--progress",
      "none"
    );
    assertOutput(rollback, "folder-copy succeeded 4 0 0");
    const remaining = await readdir(join(project, ".data/destination"), {
      recursive: true,
      withFileTypes: true,
    });
    assert.ok(remaining.every((entry) => entry.isDirectory()));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
