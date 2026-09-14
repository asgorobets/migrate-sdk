import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const waiter = fileURLToPath(
  new URL("./pilotty-wait-for.mjs", import.meta.url)
);
const textReadyAtMs = 35_000;
const requestOverheadMs = 250;

const runWait = (t, mode, timeoutMs = 60_000) => {
  const directory = mkdtempSync(join(tmpdir(), "migrate-pilotty-wait-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = join(directory, "pilotty");
  const calls = join(directory, "calls.jsonl");
  const clock = join(directory, "clock.txt");
  const clockModule = join(directory, "clock.mjs");
  writeFileSync(calls, "");
  writeFileSync(clock, "0");
  // Keep real subprocesses, but let the fake CLI advance time deterministically.
  writeFileSync(
    clockModule,
    `import { readFileSync } from "node:fs";
Object.defineProperty(performance, "now", {
  value: () => Number(readFileSync(process.env.PILOTTY_TEST_CLOCK, "utf8")),
});
`
  );
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const startedAtMs = Number(fs.readFileSync(process.env.PILOTTY_TEST_CLOCK, "utf8"));
fs.appendFileSync(process.env.PILOTTY_TEST_CALLS, JSON.stringify({ args, startedAtMs }) + "\\n");
const timeout = Number(args[args.indexOf("-t") + 1]);
if (process.env.PILOTTY_TEST_MODE === "missing-session") {
  console.error("Error: [SESSION_NOT_FOUND] Missing session");
  process.exit(1);
}
if (timeout >= 30000 || process.env.PILOTTY_TEST_MODE === "transport-failure") {
  console.log("ERROR pilotty: Request timed out");
  process.exit(1);
}
const found = process.env.PILOTTY_TEST_MODE !== "never-ready"
  && startedAtMs + timeout >= ${textReadyAtMs};
const finishedAtMs = found ? ${textReadyAtMs} : startedAtMs + timeout;
fs.writeFileSync(process.env.PILOTTY_TEST_CLOCK, String(finishedAtMs + ${requestOverheadMs}));
if (found) {
  console.log(JSON.stringify({ type: "wait_for_result", found: true }));
  process.exit(0);
}
console.error("Error: [COMMAND_FAILED] Timeout waiting for '480 migrated'");
process.exit(1);
`,
    { mode: 0o755 }
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(clockModule).href,
      waiter,
      binary,
      "catalog",
      String(timeoutMs),
      "480 migrated",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PILOTTY_TEST_CALLS: calls,
        PILOTTY_TEST_CLOCK: clock,
        PILOTTY_TEST_MODE: mode,
      },
      timeout: 5000,
    }
  );
  return {
    ...result,
    elapsedMs: Number(readFileSync(clock, "utf8")),
    calls: readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse),
  };
};

test("finds text appearing after 35 seconds using shorter waits", (t) => {
  const result = runWait(t, "eventually-ready");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.elapsedMs, textReadyAtMs + requestOverheadMs);
  assert.ok(result.calls.length > 1);
  for (const { args } of result.calls) {
    assert.equal(args[0], "wait-for");
    assert.equal(args[2], "catalog");
    assert.equal(args.at(-1), "480 migrated");
    assert.ok(Number(args[4]) < 30_000);
  }
});

test("shares one deadline across retries and shortens the final request", (t) => {
  const timeoutMs = 25_000;
  const result = runWait(t, "never-ready", timeoutMs);
  assert.equal(result.status, 1);
  assert.ok(
    result.stderr.includes(
      `Timeout waiting for '480 migrated' in session 'catalog' after ${timeoutMs}ms`
    )
  );
  assert.ok(result.calls.length > 1);
  for (const { args, startedAtMs } of result.calls) {
    assert.ok(Number(args[4]) > 0);
    assert.ok(Number(args[4]) <= timeoutMs - startedAtMs);
  }
  const lastCall = result.calls.at(-1);
  assert.equal(Number(lastCall.args[4]), timeoutMs - lastCall.startedAtMs);
  assert.equal(result.elapsedMs, timeoutMs + requestOverheadMs);
});

test("reports a missing session immediately instead of retrying", (t) => {
  const result = runWait(t, "missing-session");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("SESSION_NOT_FOUND"));
  assert.equal(result.calls.length, 1);
});

test("surfaces transport errors printed on stdout without retrying", (t) => {
  const result = runWait(t, "transport-failure");
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Request timed out"));
  assert.equal(result.calls.length, 1);
});
