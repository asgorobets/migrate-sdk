import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeTemporaryDirectory } from "./remove-temporary-directory.mjs";

test("retries while Windows releases a temporary directory", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "migrate-rm-ebusy-"));
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => undefined, 400)"],
    { cwd: directory, stdio: "ignore" }
  );
  await once(child, "spawn");

  try {
    await removeTemporaryDirectory(directory);
    assert.equal(existsSync(directory), false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await rm(directory, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    });
  }
});
