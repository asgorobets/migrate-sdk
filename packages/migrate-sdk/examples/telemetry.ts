import { Config, Effect, Schema } from "effect";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecution,
  SourceIdentity,
} from "migrate-sdk";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { completedInlineExecution } from "./inline-execution.ts";

/** A synthetic workload for comparing cursor windows and settlement concurrency. */
export const runTelemetryExample = Effect.gen(function* () {
  const batchSize = yield* Config.Int("MIGRATE_DEMO_BATCH_SIZE").pipe(
    Config.withDefault(8)
  );
  const concurrency = yield* Config.Int("MIGRATE_DEMO_CONCURRENCY").pipe(
    Config.withDefault(2)
  );
  const definition = MigrationDefinition.make({
    id: "telemetry-demo",
    source: InMemorySource.make({
      batchSize,
      identity: SourceIdentity.make({
        id: "telemetry-demo@v1",
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
          Effect.withSpan("demo.destination.submit")
        );
        yield* Effect.sleep("50 millis").pipe(
          Effect.withSpan("demo.destination.wait", {
            attributes: {
              "migration.wait.reason": "destination-poll-interval",
            },
          })
        );
        return items.map((item) =>
          item.settle(
            Effect.sleep("10 millis").pipe(
              Effect.withSpan("demo.destination.settle")
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
      execution: { process: { concurrency } },
    })
  );
});
