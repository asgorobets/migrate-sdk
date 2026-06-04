import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { Console, Effect, Layer } from "effect";
import {
  formatFileStoreExampleResult,
  runFileStoreExample,
} from "./examples/file-store-runtime.ts";
import {
  formatMigrationRunSummary,
  runInMemoryExample,
} from "./examples/in-memory-runtime.ts";
import {
  formatNestedArticleSchemaExampleResult,
  runNestedArticleSchemaExample,
} from "./examples/nested-article-schema.ts";

const example = process.argv[2] ?? "in-memory";
const shouldReset = process.argv.includes("--reset");
const nodePlatformLayer = Layer.mergeAll(nodeFileSystemLayer, nodePathLayer);

const makeProgram = () => {
  if (example === "file-store") {
    return runFileStoreExample({ reset: shouldReset }).pipe(
      Effect.provide(nodePlatformLayer),
      Effect.map(formatFileStoreExampleResult)
    );
  }

  if (example === "nested-article") {
    return runNestedArticleSchemaExample().pipe(
      Effect.map(formatNestedArticleSchemaExampleResult)
    );
  }

  return runInMemoryExample().pipe(Effect.map(formatMigrationRunSummary));
};

const program = makeProgram();

Effect.runPromise(program.pipe(Effect.flatMap(Console.log))).catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }
);
