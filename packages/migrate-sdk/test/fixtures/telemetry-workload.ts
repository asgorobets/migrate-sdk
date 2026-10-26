import { Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  SourceIdentity,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { completedInlineExecution } from "../../examples/inline-execution.ts";

/** Synthetic destination waits for telemetry assertions. */
export const telemetryWorkload = Effect.gen(function* () {
  const definition = MigrationDefinition.make({
    id: "telemetry-test",
    source: InMemorySource.make({
      batchSize: 8,
      identity: SourceIdentity.make({
        id: "telemetry-test@v1",
        schema: SourceIdentity.key("id", Schema.String),
      }),
      items: Array.from({ length: 48 }, (_, index) => ({
        identityKey: String(index),
        item: { title: `Item ${index}` },
        version: "v1",
      })),
      sourceSchema: Schema.Struct({ title: Schema.String }),
    }),
    store: InMemoryMigrationStore.layer(),
    processBatch: (items) =>
      Effect.gen(function* () {
        yield* Effect.sleep("25 millis").pipe(
          Effect.withSpan("test.destination.submit")
        );
        yield* Effect.sleep("50 millis").pipe(
          Effect.withSpan("test.destination.wait", {
            attributes: {
              "migration.wait.reason": "destination-poll-interval",
            },
          })
        );
        return items.map((item) =>
          item.settle(
            Effect.sleep("10 millis").pipe(
              Effect.withSpan("test.destination.settle")
            )
          )
        );
      }),
  });
  const registry = MigrationDefinitionRegistry.make({
    definitions: [definition],
  });
  return yield* completedInlineExecution(
    MigrationExecution.make({ registry }).run({
      all: true,
      execution: { process: { concurrency: 2 } },
    })
  );
});
