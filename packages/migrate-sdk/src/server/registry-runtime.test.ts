import { describe, expect, it } from "@effect/vitest";
import { MigrationDefinitionRegistry, MigrationExecutable } from "../index.ts";
import { makeRegistryMigrateServerRuntime } from "./registry-runtime.ts";

describe("registry migration server runtime", () => {
  it("constructs directly from an existing registry", () => {
    const runtime = makeRegistryMigrateServerRuntime({
      executable: MigrationExecutable.inlineService,
      registry: MigrationDefinitionRegistry.make({ definitions: [] }),
    });

    expect(runtime.rows).toEqual([]);
    expect(runtime.groups).toEqual([]);
  });
});
