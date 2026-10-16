import { Effect } from "effect";
import { MigrationDefinitionRegistry, MigrationExecution } from "migrate-sdk";
import { authors } from "./migration.ts";

const command = process.argv[2] ?? "run";
if (!["run", "update", "rollback"].includes(command)) {
  throw new Error("Usage: node run.ts [run|update|rollback]");
}

const execution = MigrationExecution.make({
  registry: MigrationDefinitionRegistry.make({ definitions: [authors] }),
});

const program = Effect.gen(function* () {
  const start = yield* command === "rollback"
    ? execution.rollback({ all: true })
    : execution.run({ all: true, update: command === "update" });

  if (start.kind === "completed") {
    return start.summary;
  }
  if (start.handle === undefined) {
    return yield* Effect.fail(new Error("Expected a local run handle"));
  }

  const result = yield* start.handle.wait;
  if (result.kind !== "finished") {
    return yield* Effect.fail(new Error(`Run ended: ${result.kind}`));
  }
  return result.summary;
});

const summary = await Effect.runPromise(program);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.status === "succeeded" ? 0 : 1;
