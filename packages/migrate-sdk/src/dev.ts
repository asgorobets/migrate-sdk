import { Console, Effect } from "effect";
import {
  formatMigrationRunSummary,
  runInMemoryExample,
} from "./examples/in-memory-runtime.ts";

void Effect.runPromise(
  runInMemoryExample().pipe(
    Effect.map(formatMigrationRunSummary),
    Effect.flatMap(Console.log)
  )
).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
