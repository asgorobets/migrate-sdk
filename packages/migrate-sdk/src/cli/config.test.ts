import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import {
  MigrationDefinitionRegistry,
  MigrationExecutable,
  toMigrationRunId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

describe("defineMigrationCliConfig", () => {
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
          execution: { adapter: "test" },
          kind: "started",
          runId: toMigrationRunId("run-test"),
        }),
      startRollback: () =>
        Effect.succeed({
          execution: { adapter: "test" },
          kind: "started",
          runId: toMigrationRunId("rollback-test"),
        }),
    });

    const config = defineMigrationCliConfig({ executableLayer, registry });

    expect(config.executableLayer).toBe(executableLayer);
  });
});
