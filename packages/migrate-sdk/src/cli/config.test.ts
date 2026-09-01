import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Service } from "effect/Context";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  Source,
  SourceIdentity,
  toMigrationRunId,
} from "migrate-sdk";
import {
  defineMigrationCliConfig,
  type MigrationCliConfig,
} from "migrate-sdk/cli";
import { InMemoryMigrationStore } from "migrate-sdk/stores/in-memory";
import { expectTypeOf } from "vitest";

class ApplicationSourceClient extends Service<
  ApplicationSourceClient,
  Record<never, never>
>()("@migrate-sdk/test/ApplicationSourceClient") {}

const ApplicationArticleIdentity = SourceIdentity.make({
  id: "application-article@v1",
  schema: SourceIdentity.key("articleId", Schema.NonEmptyString),
});

describe("defineMigrationCliConfig", () => {
  it("accepts registries with application source requirements", () => {
    const source = Source.fromLayer({
      cursorSchema: Schema.Null,
      identity: ApplicationArticleIdentity,
      layer: (SourceRuntimeService) =>
        Layer.effect(
          SourceRuntimeService,
          Effect.gen(function* () {
            yield* ApplicationSourceClient;
            return SourceRuntimeService.of({
              lookupStrategy: "scan",
              read: () => Effect.succeed({ items: [] }),
              readByIdentity: () => Effect.succeed(null),
            });
          })
        ),
      sourceSchema: Schema.String,
    });
    const definition = MigrationDefinition.make({
      id: "application-articles",
      process: () => Effect.void,
      source,
      store: InMemoryMigrationStore.layer(),
    });
    const registry = MigrationDefinitionRegistry.make({
      definitions: [definition],
    });

    const config = defineMigrationCliConfig({ registry });

    expect(config.registry).toBe(registry);
    expectTypeOf(config).toEqualTypeOf<
      MigrationCliConfig<readonly [typeof definition]>
    >();
  });

  it("accepts a synchronous registry config object", () => {
    const registry = MigrationDefinitionRegistry.make({ definitions: [] });

    const config = defineMigrationCliConfig({ registry });

    expect(config.registry).toBe(registry);
  });

  it("accepts a config-provided MigrationExecutable layer", () => {
    const registry = MigrationDefinitionRegistry.make({ definitions: [] });
    const executableLayer = Layer.succeed(MigrationExecutable, {
      startRun: () =>
        Effect.succeed({
          execution: { adapter: "test", executionId: "run-test" },
          kind: "started",
          runId: toMigrationRunId("run-test"),
        }),
      startRollback: () =>
        Effect.succeed({
          execution: { adapter: "test", executionId: "rollback-test" },
          kind: "started",
          runId: toMigrationRunId("rollback-test"),
        }),
    });

    const config = defineMigrationCliConfig({ executableLayer, registry });

    expect(config.executableLayer).toBe(executableLayer);
  });

  it("accepts an explicit SQL Migration Store target", () => {
    const registry = MigrationDefinitionRegistry.make({ definitions: [] });
    const clientLayer = SqliteClient.layer({
      disableWAL: true,
      filename: ":memory:",
    });
    const config = defineMigrationCliConfig({
      registry,
      sqlStore: { clientLayer, tablePrefix: "customer_migrations" },
    });

    expect(config.sqlStore).toEqual({
      clientLayer,
      tablePrefix: "customer_migrations",
    });
  });
});
