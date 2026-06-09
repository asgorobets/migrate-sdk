import { fileURLToPath } from "node:url";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stdio, Stream } from "effect";
import { pretty as prettyCause } from "effect/Cause";
import { isFailure, isSuccess } from "effect/Exit";
import { TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { MigrationCliRuntime, migrateCommand } from "migrate-sdk/cli/testing";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binPath = fileURLToPath(
  new URL("../../bin/migrate-sdk.mjs", import.meta.url)
);

const makeLayer = (cwd: string) =>
  Layer.mergeAll(
    CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
    Layer.succeed(MigrationCliRuntime, { cwd }),
    nodeServicesLayer,
    Stdio.layerTest({}),
    TestConsole.layer
  );

const runCli = (args: readonly string[], cwd: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Command.runWith(migrateCommand, { version: "0.0.0" })(args)
    );
    const stdout = (yield* TestConsole.logLines).map(String).join("\n");
    const stderr = (yield* TestConsole.errorLines).map(String).join("\n");

    return {
      cause: isFailure(exit) ? prettyCause(exit.cause) : "",
      exitCode: isSuccess(exit) ? 0 : 1,
      stderr,
      stdout,
    };
  }).pipe(Effect.provide(makeLayer(cwd)));

const runCliProcess = (args: readonly string[], cwd: string) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      process.execPath,
      [binPath, ...args],
      { cwd }
    );

    return yield* Effect.all(
      {
        exitCode: handle.exitCode,
        stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
        stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
      },
      { concurrency: "unbounded" }
    );
  });

const makeProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.makeTempDirectoryScoped({
    directory: packageRoot,
    prefix: ".migrate-cli-",
  });
});

const configSource = (definitionId: string): string => `
  import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [{ id: toMigrationDefinitionId("${definitionId}") }] as never
    })
  });
`;

const jsConfigSource = (definitionId: string): string => `
  import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [{ id: toMigrationDefinitionId("${definitionId}") }]
    })
  });
`;

describe("migrate CLI", () => {
  it.effect(
    "lists static registry metadata from an explicit TypeScript config",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          `
          import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          const definition = (id: string, input: Record<string, unknown> = {}) => ({
            id: toMigrationDefinitionId(id),
            ...input
          });

          const authors = definition("authors");
          const articles = definition("articles", {
            dependencies: {
              required: [toMigrationDefinitionId("authors")],
              optional: [toMigrationDefinitionId("images")]
            },
            rollback: () => ({ kind: "noop" })
          });

          export default defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({
              definitions: [authors, articles] as never
            })
          });
        `
        );

        const result = yield* runCli(
          ["list", "--config", "migrate.config.ts"],
          project
        );

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("authors");
        expect(result.stdout).toContain("articles");
        expect(result.stdout).toContain("rollback: yes");
        expect(result.stdout).toContain("required: authors");
        expect(result.stdout).toContain("optional: images (unresolved)");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("runs list through the package bin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        configSource("from-bin")
      );

      const result = yield* runCliProcess(["list"], project);

      expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(0));
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("from-bin");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders known config errors through the package bin without runtime stack noise",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          "export default {};\n"
        );

        const result = yield* runCliProcess(["list"], project);
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(output).toContain(
          "Migration CLI config must be created with defineMigrationCliConfig({ registry })"
        );
        expect(output).not.toContain("CliError/UserError");
        expect(output).not.toContain("at failConfigLoad");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders unknown config import stacks through the package bin",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          'throw new Error("config exploded");\n'
        );

        const result = yield* runCliProcess(["list"], project);
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.exitCode).toBe(ChildProcessSpawner.ExitCode(1));
        expect(output).toContain("Failed to import Migration CLI config");
        expect(output).toContain("Error: config exploded");
        expect(output).toContain("migrate.config.ts");
        expect(output).not.toContain("CliError/UserError");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("discovers the nearest config by searching upward from cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      const nestedPackage = `${project}/packages/site`;
      const cwd = `${nestedPackage}/src/features`;

      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.writeFileString(
        `${project}/pnpm-workspace.yaml`,
        "packages:\n  - packages/*\n"
      );
      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        configSource("root")
      );
      yield* fs.writeFileString(
        `${nestedPackage}/migrate.config.ts`,
        configSource("site")
      );

      const result = yield* runCli(["list"], cwd);

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("site");
      expect(result.stdout).not.toContain("root");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders unknown config import failures with the config path and cause",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;
        const configPath = `${project}/migrate.config.ts`;

        yield* fs.writeFileString(
          configPath,
          `
          import "missing-migrate-sdk-test-package";

          export default {};
        `
        );

        const result = yield* runCli(
          ["list", "--config", "migrate.config.ts"],
          project
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`Failed to load ${configPath}`);
        expect(result.stderr).toContain(
          "Failed to import Migration CLI config"
        );
        expect(result.stderr).toContain("missing-migrate-sdk-test-package");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders all registry construction issues thrown while importing config",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;
        const configPath = `${project}/migrate.config.ts`;

        yield* fs.writeFileString(
          configPath,
          `
          import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          const definition = (id: string, required: readonly string[]) => ({
            dependencies: {
              required: required.map(toMigrationDefinitionId),
              optional: []
            },
            id: toMigrationDefinitionId(id)
          });

          export default defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({
              definitions: [
                definition("articles", ["authors"]),
                definition("articles", ["images"])
              ] as never
            })
          });
        `
        );

        const result = yield* runCli(
          ["list", "--config", "migrate.config.ts"],
          project
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(`Failed to load ${configPath}`);
        expect(result.stderr).toContain("Registry has 3 hard errors");
        expect(result.stderr).toContain(
          "Duplicate migration definition id: articles"
        );
        expect(result.stderr).toContain(
          "articles requires authors, but authors is not registered"
        );
        expect(result.stderr).toContain(
          "articles requires images, but images is not registered"
        );
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects named-only config exports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        `
          import { MigrationDefinitionRegistry } from "migrate-sdk";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          export const config = defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({ definitions: [] })
          });
        `
      );

      const result = yield* runCli(
        ["list", "--config", "migrate.config.ts"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Migration CLI config must be exported as the default export"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("loads JavaScript config files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.mjs`,
        jsConfigSource("from-js")
      );

      const result = yield* runCli(
        ["list", "--config", "migrate.config.mjs"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("from-js");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "uses discovery filename order before falling back to JavaScript configs",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.js`,
          jsConfigSource("from-js")
        );
        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          configSource("from-ts")
        );

        const result = yield* runCli(["list"], project);

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("from-ts");
        expect(result.stdout).not.toContain("from-js");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("resolves relative imports from the config file location", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      const configDirectory = `${project}/config`;

      yield* fs.makeDirectory(configDirectory, { recursive: true });
      yield* fs.writeFileString(
        `${configDirectory}/registry.ts`,
        `
          import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";

          export const registry = MigrationDefinitionRegistry.make({
            definitions: [{ id: toMigrationDefinitionId("relative-import") }] as never
          });
        `
      );
      yield* fs.writeFileString(
        `${configDirectory}/migrate.config.ts`,
        `
          import { defineMigrationCliConfig } from "migrate-sdk/cli";
          import { registry } from "./registry.ts";

          export default defineMigrationCliConfig({ registry });
        `
      );

      const result = yield* runCli(
        ["list", "--config", "config/migrate.config.ts"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("relative-import");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("stops discovery at a workspace root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const outer = yield* makeProject;
      const workspaceRoot = `${outer}/workspace`;
      const cwd = `${workspaceRoot}/packages/site/src`;

      yield* fs.makeDirectory(cwd, { recursive: true });
      yield* fs.writeFileString(
        `${outer}/migrate.config.ts`,
        configSource("outside-workspace")
      );
      yield* fs.writeFileString(
        `${workspaceRoot}/pnpm-workspace.yaml`,
        "packages:\n  - packages/*\n"
      );

      const result = yield* runCli(["list"], cwd);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No Migration CLI config was found");
      expect(result.stdout).not.toContain("outside-workspace");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("does not search downward into child packages", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      const childPackage = `${project}/packages/site`;

      yield* fs.makeDirectory(childPackage, { recursive: true });
      yield* fs.writeFileString(
        `${project}/pnpm-workspace.yaml`,
        "packages:\n  - packages/*\n"
      );
      yield* fs.writeFileString(
        `${childPackage}/migrate.config.ts`,
        configSource("child-package")
      );

      const result = yield* runCli(["list"], project);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No Migration CLI config was found");
      expect(result.stdout).not.toContain("child-package");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects async config defaults", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        `
          import { MigrationDefinitionRegistry } from "migrate-sdk";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          export default Promise.resolve(defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({ definitions: [] })
          }));
        `
      );

      const result = yield* runCli(
        ["list", "--config", "migrate.config.ts"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Migration CLI config must be synchronous"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("loads MTS config files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.mts`,
        configSource("from-mts")
      );

      const result = yield* runCli(
        ["list", "--config", "migrate.config.mts"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("from-mts");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );
});
