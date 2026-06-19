import { fileURLToPath } from "node:url";
import { Console, Effect } from "effect";
import {
  formatProductCatalogStoreMigrationExampleResult,
  runProductCatalogStoreMigrationExample,
} from "./product-catalog-store-migration.ts";

export const runProductDestinationExample =
  runProductCatalogStoreMigrationExample;

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  Effect.runPromise(
    runProductDestinationExample().pipe(
      Effect.map(formatProductCatalogStoreMigrationExampleResult),
      Effect.flatMap(Console.log)
    )
  ).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
