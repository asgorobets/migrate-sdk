import assert from "node:assert/strict";
import { resolve } from "node:path";
import { toMigrationDefinitionId } from "migrate-sdk";
import { makeMigrationTuiRuntime } from "../../src/index.ts";

const runtime = await makeMigrationTuiRuntime({
  configPath: resolve("test/fixtures/node-only.config.ts"),
  cwd: process.cwd(),
});

try {
  assert.deepEqual(
    runtime.rows.map((row) => row.entry.id),
    ["packaging-fixture"]
  );

  const operation = await runtime.prepare(
    {
      definitionIds: [toMigrationDefinitionId("packaging-fixture")],
      kind: "definitions",
    },
    "run"
  );
  const reference = await runtime.start(operation);
  const result = await runtime.observeRun(reference.runId);

  assert.match(result.message, /succeeded/);
  assert.equal((await runtime.refresh()).rows[0]?.status?.durable.migrated, 1);
} finally {
  await runtime.dispose?.();
}
