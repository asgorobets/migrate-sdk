import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "@effect/vitest";

it("summarizes large item states within a bounded heap", async () => {
  const fixture = fileURLToPath(
    new URL(
      "../../test-fixtures/item-state-summary-memory.mjs",
      import.meta.url
    )
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--conditions=source",
      "--import=tsx",
      fixture,
    ],
    { timeout: 20_000 }
  );

  expect(JSON.parse(stdout).summary).toEqual({
    failed: 300,
    migrated: 300,
    needsUpdate: 300,
    skipped: 300,
  });
}, 25_000);
