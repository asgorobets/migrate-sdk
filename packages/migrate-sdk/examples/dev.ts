import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { layer as nodePathLayer } from "@effect/platform-node/NodePath";
import { Console, Effect, Layer } from "effect";
import { formatApiSourceExampleResult } from "./api-source/format.ts";
import { runApiSourceExampleWithInspection } from "./api-source/inspection.ts";
import {
  formatCircularBookAuthorStubsExampleResult,
  runCircularBookAuthorStubsExample,
} from "./circular-book-author-stubs.ts";
import {
  formatFileStoreExampleResult,
  runFileStoreExample,
} from "./file-store-runtime.ts";
import {
  formatMigrationRunSummary,
  runInMemoryExample,
} from "./in-memory-runtime.ts";
import {
  formatNestedArticleSchemaExampleResult,
  runNestedArticleSchemaExample,
} from "./nested-article-schema.ts";

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

  if (example === "api-source") {
    return runApiSourceExampleWithInspection().pipe(
      Effect.map(formatApiSourceExampleResult)
    );
  }

  if (example === "circular-stubs") {
    return runCircularBookAuthorStubsExample().pipe(
      Effect.map(formatCircularBookAuthorStubsExampleResult)
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
