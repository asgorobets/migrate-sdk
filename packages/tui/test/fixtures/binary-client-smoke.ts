import assert from "node:assert/strict";
import { toMigrationDefinitionId } from "migrate-sdk";
import { makeMigrationTuiRuntime } from "../../src/index.ts";

const runtime = await makeMigrationTuiRuntime({
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
  assert.equal(result.outcome, "completed");
  assert.equal((await runtime.refresh()).rows[0]?.status?.durable.migrated, 1);
  console.log("Standalone client executed the Node-only migration");
} finally {
  await runtime.dispose?.();
}
