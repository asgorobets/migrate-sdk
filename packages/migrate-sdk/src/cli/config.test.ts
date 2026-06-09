import { describe, expect, it } from "@effect/vitest";
import { MigrationDefinitionRegistry } from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";

describe("defineMigrationCliConfig", () => {
  it("accepts a synchronous registry-only config object", () => {
    const registry = MigrationDefinitionRegistry.make({ definitions: [] });

    const config = defineMigrationCliConfig({ registry });

    expect(config.registry).toBe(registry);
  });
});
