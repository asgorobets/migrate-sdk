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

const graphConfigSource = (): string => `
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
      optional: [
        toMigrationDefinitionId("images"),
        toMigrationDefinitionId("article-tags")
      ]
    }
  });
  const articleTags = definition("article-tags", {
    dependencies: {
      required: [],
      optional: [toMigrationDefinitionId("articles")]
    }
  });
  const comments = definition("comments", {
    dependencies: {
      required: [toMigrationDefinitionId("articles")],
      optional: []
    }
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [authors, articles, articleTags, comments] as never
    })
  });
`;

const planConfigSource = (): string => `
  import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const definition = (id: string, input: Record<string, unknown> = {}) => ({
    id: toMigrationDefinitionId(id),
    pipeline: () => {
      throw new Error(id + " executed");
    },
    ...input
  });

  const authors = definition("authors");
  const articles = definition("articles", {
    dependencies: {
      required: [toMigrationDefinitionId("authors")],
      optional: [toMigrationDefinitionId("tags")]
    },
    rollback: () => ({ kind: "noop" })
  });
  const tags = definition("tags", {
    rollback: () => ({ kind: "noop" })
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [tags, articles, authors] as never
    })
  });
`;

const planNoticeConfigSource = (): string => `
  import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const definition = (id: string, optional: readonly string[] = []) => ({
    id: toMigrationDefinitionId(id),
    dependencies: {
      required: [],
      optional: optional.map(toMigrationDefinitionId)
    }
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [
        definition("articles", ["tags"]),
        definition("tags", ["articles"])
      ] as never
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

  it.effect("renders the full static dependency graph", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        graphConfigSource()
      );

      const result = yield* runCli(
        ["graph", "--config", "migrate.config.ts"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Migration Dependency Graph");
      expect(result.stdout).toContain("articles(required) --> authors");
      expect(result.stdout).toContain("articles(optional) --> article-tags");
      expect(result.stdout).toContain(
        "articles(optional unresolved) --> images"
      );
      expect(result.stdout).toContain("comments(required) --> articles");
      expect(result.stdout).toContain("article-tags(optional) --> articles");
      expect(result.stdout).not.toContain("--with-dependencies");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders a focused one-hop dependency graph", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        graphConfigSource()
      );

      const result = yield* runCli(
        ["graph", "--config", "migrate.config.ts", "comments"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Migration Dependency Graph: comments");
      expect(result.stdout).toContain("comments(required) --> articles");
      expect(result.stdout).not.toContain("articles(required) --> authors");
      expect(result.stdout).not.toContain(
        "articles(optional) --> article-tags"
      );
      expect(result.stdout).not.toContain(
        "articles(optional unresolved) --> images"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders incoming and outgoing edges for a focused graph", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        graphConfigSource()
      );

      const result = yield* runCli(
        ["graph", "--config", "migrate.config.ts", "articles"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("articles(required) --> authors");
      expect(result.stdout).toContain("articles(optional) --> article-tags");
      expect(result.stdout).toContain(
        "articles(optional unresolved) --> images"
      );
      expect(result.stdout).toContain("comments(required) --> articles");
      expect(result.stdout).toContain("article-tags(optional) --> articles");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("fails clearly for an unknown focused graph definition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        graphConfigSource()
      );

      const result = yield* runCli(
        ["graph", "--config", "migrate.config.ts", "missing"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Migration Definition was not found in the registry: missing"
      );
      expect(result.stderr).not.toContain("CliError/UserError");
      expect(result.stdout).toBe("");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders an empty dependency graph clearly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        `
          import { MigrationDefinitionRegistry, toMigrationDefinitionId } from "migrate-sdk";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          export default defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({
              definitions: [{ id: toMigrationDefinitionId("standalone") }] as never
            })
          });
        `
      );

      const result = yield* runCli(
        ["graph", "--config", "migrate.config.ts"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Migration Dependency Graph");
      expect(result.stdout).toContain("No dependencies.");
      expect(result.stdout).not.toContain("-->");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders a run plan with requested and execution order without executing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const result = yield* runCli(
          [
            "run",
            "--config",
            "migrate.config.ts",
            "--plan",
            "--with-dependencies",
            "articles",
            "tags",
          ],
          project
        );

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Run plan");
        expect(result.stdout).toContain("Requested:\narticles\ntags");
        expect(result.stdout).toContain("Included:\ntags\narticles\nauthors");
        expect(result.stdout).toContain(
          "Execution order:\n1. tags\n2. authors\n3. articles"
        );
        expect(result.stdout).not.toContain("executed");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders a rollback plan with target ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const result = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article-1,article-2",
          "tags",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rollback plan");
      expect(result.stdout).toContain("Requested:\ntags");
      expect(result.stdout).toContain("Target ids:\narticle-1, article-2");
      expect(result.stdout).toContain("Included:\ntags");
      expect(result.stdout).toContain("Execution order:\n1. tags");
      expect(result.stdout).not.toContain("executed");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders rollback requested order separately from execution order",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const result = yield* runCli(
          [
            "rollback",
            "--config",
            "migrate.config.ts",
            "--plan",
            "authors",
            "articles",
          ],
          project
        );

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Requested:\nauthors\narticles");
        expect(result.stdout).toContain("Included:\narticles\nauthors");
        expect(result.stdout).toContain(
          "Execution order:\n1. articles\n2. authors"
        );
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders run plan notices", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planNoticeConfigSource()
      );

      const result = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "articles",
          "articles",
          "tags",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run plan");
      expect(result.stdout).toContain("Requested:\narticles\narticles\ntags");
      expect(result.stdout).toContain(
        "Notices:\n- Duplicate requested definition ignored: articles"
      );
      expect(result.stdout).toContain(
        "- Ignored optional dependency cycle: articles -> tags -> articles"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders missing required dependency suggestions for run plans",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const result = yield* runCli(
          ["run", "--config", "migrate.config.ts", "--plan", "articles"],
          project
        );

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "Migration Definition selection is missing required dependencies"
        );
        expect(result.stderr).toContain(
          "articles is missing required dependencies: authors"
        );
        expect(result.stderr).toContain(
          "migrate run --plan --with-dependencies articles"
        );
        expect(result.stderr).toContain("migrate run --plan authors articles");
        expect(result.stderr).not.toContain(
          "MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError"
        );
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("preserves run mode flags in missing dependency suggestions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const result = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--failed",
          "articles",
        ],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "migrate run --plan --failed --with-dependencies articles"
      );
      expect(result.stderr).toContain(
        "migrate run --plan --failed authors articles"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "does not render missing dependency suggestions for targeted plans",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const runResult = yield* runCli(
          [
            "run",
            "--config",
            "migrate.config.ts",
            "--plan",
            "--ids",
            "article-1",
            "articles",
          ],
          project
        );
        const rollbackResult = yield* runCli(
          [
            "rollback",
            "--config",
            "migrate.config.ts",
            "--plan",
            "--ids",
            "article-1",
            "articles",
          ],
          project
        );

        for (const result of [runResult, rollbackResult]) {
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain(
            "Migration Definition selection is missing required dependencies"
          );
          expect(result.stderr).toContain(
            "articles is missing required dependencies: authors"
          );
          expect(result.stderr).not.toContain("Try:");
          expect(result.stderr).not.toContain("--with-dependencies");
          expect(result.stderr).not.toContain("authors articles");
        }
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "renders rollback missing dependency suggestions with dependency expansion first",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const result = yield* runCli(
          ["rollback", "--config", "migrate.config.ts", "--plan", "articles"],
          project
        );
        const expansionSuggestion =
          "migrate rollback --plan --with-dependencies articles";
        const explicitSuggestion = "migrate rollback --plan authors articles";

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
          "Migration Definition selection is missing required dependencies"
        );
        expect(result.stderr.indexOf(expansionSuggestion)).toBeGreaterThan(-1);
        expect(result.stderr.indexOf(expansionSuggestion)).toBeLessThan(
          result.stderr.indexOf(explicitSuggestion)
        );
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders failed and skipped run modes in run plans", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const result = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--plan", "--failed", "tags"],
        project
      );
      const skippedResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--plan", "--skipped", "tags"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run plan");
      expect(result.stdout).toContain("Mode:\nfailed");
      expect(result.stdout).toContain("Execution order:\n1. tags");
      expect(skippedResult.stderr).toBe("");
      expect(skippedResult.exitCode).toBe(0);
      expect(skippedResult.stdout).toContain("Mode:\nskipped");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects generic and conflicting run mode flags", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const genericModeResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--mode",
          "failed",
          "tags",
        ],
        project
      );
      const conflictingModeResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--failed",
          "--skipped",
          "tags",
        ],
        project
      );

      expect(genericModeResult.exitCode).toBe(1);
      expect(genericModeResult.stderr).toContain("Unrecognized flag: --mode");
      expect(conflictingModeResult.exitCode).toBe(1);
      expect(conflictingModeResult.stderr).toContain(
        "Run planning cannot combine --failed and --skipped"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("expands required dependencies only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const result = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--with-dependencies",
          "articles",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Included:\narticles\nauthors");
      expect(result.stdout).not.toContain("Included:\ntags\narticles\nauthors");
      expect(result.stdout).toContain(
        "Execution order:\n1. authors\n2. articles"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "parses encoded target ids and renders duplicate target notices",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const result = yield* runCli(
          [
            "rollback",
            "--config",
            "migrate.config.ts",
            "--plan",
            "--ids",
            "article%2C1,article-2,article%2C1",
            "tags",
          ],
          project
        );

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Target ids:\narticle,1, article-2");
        expect(result.stdout).toContain(
          "Notices:\n- Duplicate target id ignored: article,1"
        );
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects malformed ids before planning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const emptySegmentResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article-1,,article-2",
          "tags",
        ],
        project
      );
      const invalidEncodingResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article-%E0%A4%A",
          "tags",
        ],
        project
      );

      expect(emptySegmentResult.exitCode).toBe(1);
      expect(emptySegmentResult.stderr).toContain(
        "--ids must not contain empty comma-separated segments"
      );
      expect(emptySegmentResult.stderr).not.toContain(
        "Migration Definition selection is missing required dependencies"
      );
      expect(invalidEncodingResult.exitCode).toBe(1);
      expect(invalidEncodingResult.stderr).toContain(
        "--ids contains invalid percent encoding"
      );
      expect(invalidEncodingResult.stderr).not.toContain(
        "Migration Definition selection is missing required dependencies"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders run item target ids", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const result = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article%2C1",
          "tags",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run plan");
      expect(result.stdout).toContain("Requested:\ntags");
      expect(result.stdout).toContain("Target ids:\narticle,1");
      expect(result.stdout).toContain("Execution order:\n1. tags");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects incompatible run item targeting combinations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const multipleIdsResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article-1,article-2",
          "tags",
        ],
        project
      );
      const allResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--all",
          "--ids",
          "article-1",
        ],
        project
      );
      const multipleDefinitionsResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article-1",
          "tags",
          "authors",
        ],
        project
      );
      const expandedResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--with-dependencies",
          "--ids",
          "article-1",
          "tags",
        ],
        project
      );
      const failedResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--failed",
          "--ids",
          "article-1",
          "tags",
        ],
        project
      );
      const skippedResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--skipped",
          "--ids",
          "article-1",
          "tags",
        ],
        project
      );

      expect(multipleIdsResult.exitCode).toBe(1);
      expect(multipleIdsResult.stderr).toContain(
        "Run source identity targeting requires exactly one source identity"
      );
      expect(allResult.exitCode).toBe(1);
      expect(allResult.stderr).toContain(
        "Run source identity targeting requires exactly one explicit Migration Definition id"
      );
      expect(multipleDefinitionsResult.exitCode).toBe(1);
      expect(multipleDefinitionsResult.stderr).toContain(
        "Run source identity targeting requires exactly one explicit Migration Definition id"
      );
      expect(expandedResult.exitCode).toBe(1);
      expect(expandedResult.stderr).toContain(
        "Run source identity targeting cannot expand required dependencies"
      );
      expect(failedResult.exitCode).toBe(1);
      expect(failedResult.stderr).toContain(
        "Run source identity targeting cannot combine with another run mode"
      );
      expect(skippedResult.exitCode).toBe(1);
      expect(skippedResult.stderr).toContain(
        "Run source identity targeting cannot combine with another run mode"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects incompatible rollback targeting combinations", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const allResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--all",
          "--ids",
          "article-1",
        ],
        project
      );
      const multipleDefinitionsResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--ids",
          "article-1",
          "tags",
          "authors",
        ],
        project
      );
      const expandedResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--with-dependencies",
          "--ids",
          "article-1",
          "tags",
        ],
        project
      );

      expect(allResult.exitCode).toBe(1);
      expect(allResult.stderr).toContain(
        "Rollback source identity targeting requires exactly one explicit Migration Definition id"
      );
      expect(multipleDefinitionsResult.exitCode).toBe(1);
      expect(multipleDefinitionsResult.stderr).toContain(
        "Rollback source identity targeting requires exactly one explicit Migration Definition id"
      );
      expect(expandedResult.exitCode).toBe(1);
      expect(expandedResult.stderr).toContain(
        "Rollback source identity targeting cannot expand required dependencies"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders all-registry plans and rejects omitted scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const runAllResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--plan", "--all"],
        project
      );
      const rollbackAllResult = yield* runCli(
        ["rollback", "--config", "migrate.config.ts", "--plan", "--all"],
        project
      );
      const runOmittedScopeResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--plan"],
        project
      );
      const rollbackOmittedScopeResult = yield* runCli(
        ["rollback", "--config", "migrate.config.ts", "--plan"],
        project
      );

      expect(runAllResult.stderr).toBe("");
      expect(runAllResult.exitCode).toBe(0);
      expect(runAllResult.stdout).toContain("Requested:\nall");
      expect(runAllResult.stdout).toContain(
        "Included:\ntags\narticles\nauthors"
      );
      expect(runAllResult.stdout).toContain(
        "Execution order:\n1. tags\n2. authors\n3. articles"
      );
      expect(rollbackAllResult.stderr).toBe("");
      expect(rollbackAllResult.exitCode).toBe(0);
      expect(rollbackAllResult.stdout).toContain("Requested:\nall");
      expect(rollbackAllResult.stdout).toContain(
        "Execution order:\n1. articles\n2. authors\n3. tags"
      );
      expect(runOmittedScopeResult.exitCode).toBe(1);
      expect(runOmittedScopeResult.stderr).toContain(
        "Registry planning requires all: true or at least one Migration Definition id"
      );
      expect(rollbackOmittedScopeResult.exitCode).toBe(1);
      expect(rollbackOmittedScopeResult.stderr).toContain(
        "Registry planning requires all: true or at least one Migration Definition id"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects unsupported CLI plan flags", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const jsonResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--plan", "--json", "tags"],
        project
      );
      const dependencyAliasResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--plan", "-w", "tags"],
        project
      );
      const sourceIdentityResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--source-identity",
          "article-1",
          "tags",
        ],
        project
      );

      expect(jsonResult.exitCode).toBe(1);
      expect(jsonResult.stderr).toContain("Unrecognized flag: --json");
      expect(dependencyAliasResult.exitCode).toBe(1);
      expect(dependencyAliasResult.stderr).toContain("Unrecognized flag: -w");
      expect(sourceIdentityResult.exitCode).toBe(1);
      expect(sourceIdentityResult.stderr).toContain(
        "Unrecognized flag: --source-identity"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders migrate as the command name in help", () =>
    Effect.gen(function* () {
      const project = yield* makeProject;

      const result = yield* runCli(["--help"], project);

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("USAGE\n  migrate <subcommand> [flags]");
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
