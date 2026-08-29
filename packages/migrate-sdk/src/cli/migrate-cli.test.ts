import { fileURLToPath } from "node:url";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema, Stdio, Stream } from "effect";
import { pretty as prettyCause } from "effect/Cause";
import { isFailure, isSuccess } from "effect/Exit";
import { TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  DuplicateSourceIdentityStatusWarning,
  MigrationMessage,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "migrate-sdk";
import { MigrationCliRuntime, migrateCommand } from "migrate-sdk/cli/testing";
import { renderStatusReport } from "./render.ts";
import type { MigrationCliRuntimeShape } from "./runtime.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binPath = fileURLToPath(
  new URL("../../bin/migrate-sdk.mjs", import.meta.url)
);

const activeLockedStatusRowPattern =
  /running\s+active\s+full\s+running\s+locked/;
const staleRunningStatusRowPattern = /warning\s+stale\s+full\s+running\s+clear/;
const JsonString = Schema.fromJsonString(Schema.String);
const MigrationMessagesFromJson = Schema.fromJsonString(
  Schema.Array(MigrationMessage)
);

interface CliRuntimeTestOptions {
  readonly confirmSchemaUpgrade?: NonNullable<
    MigrationCliRuntimeShape["confirmSchemaUpgrade"]
  >;
  readonly stdoutIsTTY?: boolean;
}

const makeLayer = (cwd: string, runtimeOptions: CliRuntimeTestOptions = {}) =>
  Layer.mergeAll(
    CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
    Layer.succeed(MigrationCliRuntime, { cwd, ...runtimeOptions }),
    nodeServicesLayer,
    Stdio.layerTest({}),
    TestConsole.layer
  );

const runCliWithRuntime = (
  args: readonly string[],
  cwd: string,
  runtimeOptions: CliRuntimeTestOptions = {}
) =>
  Effect.gen(function* () {
    const stdoutOffset = (yield* TestConsole.logLines).length;
    const stderrOffset = (yield* TestConsole.errorLines).length;
    const exit = yield* Effect.exit(
      Command.runWith(migrateCommand, { version: "0.0.0" })(args)
    );
    const stdout = (yield* TestConsole.logLines)
      .slice(stdoutOffset)
      .map(String)
      .join("\n");
    const stderr = (yield* TestConsole.errorLines)
      .slice(stderrOffset)
      .map(String)
      .join("\n");

    return {
      cause: isFailure(exit) ? prettyCause(exit.cause) : "",
      exitCode: isSuccess(exit) ? 0 : 1,
      stderr,
      stdout,
    };
  }).pipe(Effect.provide(makeLayer(cwd, runtimeOptions)));

const runCli = (args: readonly string[], cwd: string) =>
  runCliWithRuntime(args, cwd);

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

const readCliFixture = (name: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFileString(
        fileURLToPath(
          new URL(`../../test-fixtures/cli/${name}`, import.meta.url)
        )
      )
    )
  );

const tsDefinitionFixtureSource = (
  processExpression = "() => undefined",
  sourceDiscovery: "full" | "incremental" = "full"
): string => `
  const CliFixtureSource = Schema.Struct({ id: Schema.NonEmptyString });
  const cliFixtureSourceIdentity = SourceIdentity.make({
    id: "cli-fixture@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const cliFixtureSource = InMemorySource.make({
    batchSize: 1,
    discovery: "${sourceDiscovery}",
    identity: cliFixtureSourceIdentity,
    sourceSchema: CliFixtureSource,
    items: []
  });
  const cliFixtureStore = InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState());

  interface DefinitionFixtureInput {
    readonly dependencies?: {
      readonly required?: readonly string[];
      readonly optional?: readonly string[];
    };
    readonly group?: string;
    readonly rollback?: () => undefined;
  }

  const definition = (id: string, input: DefinitionFixtureInput = {}) =>
    MigrationDefinition.make({
      id,
      source: cliFixtureSource,
      store: cliFixtureStore,
      process: ${processExpression},
      ...input
    });
`;

const jsDefinitionFixtureSource = (): string => `
  const CliFixtureSource = Schema.Struct({ id: Schema.NonEmptyString });
  const cliFixtureSourceIdentity = SourceIdentity.make({
    id: "cli-fixture@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const cliFixtureSource = InMemorySource.make({
    batchSize: 1,
    identity: cliFixtureSourceIdentity,
    sourceSchema: CliFixtureSource,
    items: []
  });
  const cliFixtureStore = InMemoryMigrationStore.layer(InMemoryMigrationStore.makeState());

  const definition = (id, input = {}) =>
    MigrationDefinition.make({
      id,
      source: cliFixtureSource,
      store: cliFixtureStore,
      process: () => undefined,
      ...input
    });
`;

const configSource = (
  definitionId: string,
  sourceDiscovery?: "full" | "incremental"
): string => `
  import {
    MigrationDefinition,
    MigrationDefinitionRegistry,
    SourceIdentity,
  } from "migrate-sdk";
  import {
    InMemorySource,
  } from "migrate-sdk/sources/in-memory";
  import {
    InMemoryMigrationStore,
  } from "migrate-sdk/stores/in-memory";
  import { Schema } from "effect";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  ${tsDefinitionFixtureSource("() => undefined", sourceDiscovery)}

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [definition("${definitionId}")]
    })
  });
`;

const sqlStoreSchemaConfigSource = (
  filename: string,
  tablePrefix = "cli_schema"
): string => `
  import { SqliteClient } from "@effect/sql-sqlite-node";
  import {
    MigrationDefinition,
    MigrationDefinitionRegistry,
    SourceIdentity,
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";
  import { InMemorySource } from "migrate-sdk/sources/in-memory";
  import { SqlMigrationStore } from "migrate-sdk/stores/sql";
  import { Schema } from "effect";

  const tablePrefix = ${Schema.encodeSync(JsonString)(tablePrefix)};
  const clientLayer = SqliteClient.layer({
    disableWAL: true,
    filename: ${Schema.encodeSync(JsonString)(filename)}
  });
  const identity = SourceIdentity.make({
    id: "cli-schema-smoke@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const source = InMemorySource.make({
    identity,
    items: [{
      identityKey: "article-1",
      item: { title: "Schema smoke article" },
      version: "source-version-1"
    }],
    sourceSchema: Schema.Struct({ title: Schema.String })
  });
  const store = SqlMigrationStore.layerFromClient(clientLayer, {
    initialize: false,
    tablePrefix
  });
  const articles = MigrationDefinition.make({
    id: "articles",
    process: () => undefined,
    source,
    store
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({ definitions: [articles] }),
    sqlStore: {
      clientLayer,
      tablePrefix
    }
  });
`;

const CliSchemaPlan = Schema.Struct({
  currentVersion: Schema.NullOr(Schema.Number),
  planId: Schema.String,
  status: Schema.String,
  tablePrefix: Schema.String,
  targetVersion: Schema.Number,
});

const decodeCliSchemaPlan = (output: string) => {
  const lines = output.trim().split("\n");
  const lastLine = lines.at(-1) ?? "";

  return Schema.decodeUnknownSync(CliSchemaPlan)(JSON.parse(lastLine));
};

const jsConfigSource = (definitionId: string): string => `
  import {
    MigrationDefinition,
    MigrationDefinitionRegistry,
    SourceIdentity,
  } from "migrate-sdk";
  import {
    InMemorySource,
  } from "migrate-sdk/sources/in-memory";
  import {
    InMemoryMigrationStore,
  } from "migrate-sdk/stores/in-memory";
  import { Schema } from "effect";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  ${jsDefinitionFixtureSource()}

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [definition("${definitionId}")]
    })
  });
`;

const graphConfigSource = (): string => `
  import {
    MigrationDefinition,
    MigrationDefinitionRegistry,
    SourceIdentity,
  } from "migrate-sdk";
  import {
    InMemorySource,
  } from "migrate-sdk/sources/in-memory";
  import {
    InMemoryMigrationStore,
  } from "migrate-sdk/stores/in-memory";
  import { Schema } from "effect";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  ${tsDefinitionFixtureSource()}

  const authors = definition("authors");
  const articles = definition("articles", {
    dependencies: {
      required: ["authors"],
      optional: [
        "images",
        "article-tags"
      ]
    }
  });
  const articleTags = definition("article-tags", {
    dependencies: {
      required: [],
      optional: ["articles"]
    }
  });
  const comments = definition("comments", {
    dependencies: {
      required: ["articles"],
      optional: []
    }
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [authors, articles, articleTags, comments]
    })
  });
`;

const planConfigSource = (sourceDiscovery?: "full" | "incremental"): string => `
  import {
    MigrationDefinition,
    MigrationDefinitionRegistry,
    SourceIdentity,
  } from "migrate-sdk";
  import {
    InMemorySource,
  } from "migrate-sdk/sources/in-memory";
  import {
    InMemoryMigrationStore,
  } from "migrate-sdk/stores/in-memory";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";
  import { Schema } from "effect";

  ${tsDefinitionFixtureSource(
    '() => { throw new Error("definition executed"); }',
    sourceDiscovery
  )}

  const authors = definition("authors", {
    group: "articles"
  });
  const articles = definition("articles", {
    dependencies: {
      required: ["authors"],
      optional: ["tags"]
    },
    group: "articles",
    rollback: () => undefined
  });
  const tags = definition("tags", {
    group: "articles",
    rollback: () => undefined
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [tags, articles, authors]
    })
  });
`;

const lockedStoreConfigSource = (): string => `
  import { Effect, Layer, Schema } from "effect";
  import {
    MigrationDefinition,
    MigrationDefinitionRegistry,
    MigrationStore,
    SourceIdentity,
    toMigrationDefinitionId,
    toMigrationDefinitionLockToken,
    toMigrationRunId,
  } from "migrate-sdk";
  import {
    InMemorySource,
  } from "migrate-sdk/sources/in-memory";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const storeState = {
    definitionLocks: new Map(),
    latestRunStates: new Map()
  };
  const articlesId = toMigrationDefinitionId("articles");

  storeState.definitionLocks.set(articlesId, {
    createdAt: new Date("2026-06-23T00:00:00.000Z"),
    definitionId: articlesId,
    ownerRunId: toMigrationRunId("run-stuck"),
    token: toMigrationDefinitionLockToken("lock-stuck")
  });

  globalThis.__migrateSdkCliExecutionProbe = {
    executions: [],
    storeState
  };

  const store = Layer.succeed(MigrationStore, {
    listOrphanItemStates: () => Effect.die("not implemented"),
    observeItemState: () => Effect.die("not implemented"),
    getRunState: () => Effect.die("not implemented"),
    getDefinitionLock: (definitionId) =>
      Effect.sync(() => storeState.definitionLocks.get(definitionId) ?? null),
    breakDefinitionLock: (definitionId) =>
      Effect.sync(() => {
        const lock = storeState.definitionLocks.get(definitionId) ?? null;
        storeState.definitionLocks.delete(definitionId);

        return lock;
      })
  });

  const articles = MigrationDefinition.make({
    id: articlesId,
    source: InMemorySource.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: []
    }),
    store,
    process: () => undefined
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [articles]
    })
  });
`;

interface CliExecutionProbe {
  readonly storeState: {
    readonly definitionLocks: Map<unknown, unknown>;
  };
}

const getExecutionProbe = (): CliExecutionProbe => {
  const probe = (globalThis as Record<string, unknown>)
    .__migrateSdkCliExecutionProbe;

  if (typeof probe !== "object" || probe === null) {
    throw new Error("CLI execution probe was not initialized");
  }

  return probe as CliExecutionProbe;
};

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
          import {
            MigrationDefinition,
            MigrationDefinitionRegistry,
            SourceIdentity,
          } from "migrate-sdk";
          import {
            InMemorySource,
          } from "migrate-sdk/sources/in-memory";
          import {
            InMemoryMigrationStore,
          } from "migrate-sdk/stores/in-memory";
          import { Schema } from "effect";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          ${tsDefinitionFixtureSource()}

          const authors = definition("authors");
          const articles = definition("articles", {
            dependencies: {
              required: ["authors"],
              optional: ["images"]
            },
            group: "content",
            rollback: () => undefined
          });

          export default defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({
              definitions: [authors, articles]
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
        expect(result.stdout).toContain("Migration ID");
        expect(result.stdout).toContain("Rollback");
        expect(result.stdout).toContain("Group");
        expect(result.stdout).toContain("Required");
        expect(result.stdout).toContain("Optional");
        expect(result.stdout).toContain("authors");
        expect(result.stdout).toContain("articles");
        expect(result.stdout).toContain("yes");
        expect(result.stdout).toContain("authors");
        expect(result.stdout).toContain("images (unresolved)");
        expect(result.stdout).toContain("content");
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
        configSource("standalone")
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

  it.effect("renders durable-only status for explicit definitions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status.config.ts")
      );

      const result = yield* runCli(
        ["status", "--config", "migrate.config.ts", "articles"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Migration Status");
      expect(result.stdout).toContain("Scope");
      expect(result.stdout).toContain("Requested  articles");
      expect(result.stdout).toContain("State");
      expect(result.stdout).toContain("ok");
      expect(result.stdout).toContain("Migration ID");
      expect(result.stdout).toContain("Discovery");
      expect(result.stdout).toContain("full");
      expect(result.stdout).toContain("Last Run");
      expect(result.stdout).toContain("Migrated");
      expect(result.stdout).toContain("articles");
      expect(result.stdout).toContain("succeeded");
      expect(result.stdout).toContain("Skipped");
      expect(result.stdout).toContain(
        "Hint       Pass --scan-source to include source inventory counts."
      );
      expect(result.stdout).not.toContain("Unprocessed");
      expect(result.stdout).not.toContain("Orphaned");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("warns about incremental discovery in status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource("incremental")
      );

      const result = yield* runCli(
        ["status", "--config", "migrate.config.ts", "tags"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Discovery");
      expect(result.stdout).toContain("incremental");
      expect(result.stdout).toContain("Warnings:");
      expect(result.stdout).toContain(
        "tags uses incremental source discovery. Once a cursor is saved, changes at or before it will not be discovered. Pass --rescan to scan from the beginning."
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("requires an explicit status scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status.config.ts")
      );

      const result = yield* runCli(
        ["status", "--config", "migrate.config.ts"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Registry planning requires all: true, a Migration Definition group, or at least one Migration Definition id"
      );
      expect(result.stdout).toBe("");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders status for all registered definitions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status.config.ts")
      );

      const result = yield* runCli(
        ["status", "--config", "migrate.config.ts", "--all"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Requested  all");
      expect(result.stdout).toContain("Included   articles");
      expect(result.stdout).toContain("succeeded");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders status for a Migration Definition group", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        planConfigSource()
      );

      const result = yield* runCli(
        ["status", "--config", "migrate.config.ts", "--group", "articles"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Group      articles");
      expect(result.stdout).toContain("Requested  tags, articles, authors");
      expect(result.stdout).toContain("Included   tags, articles, authors");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders durable messages for one Migration Definition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("messages.config.ts")
      );

      const result = yield* runCli(
        ["messages", "--config", "migrate.config.ts", "articles"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Migration Messages");
      expect(result.stdout).toContain("Requested  articles");
      expect(result.stdout).toContain("Included   articles");
      expect(result.stdout).toContain(
        "Migration Definition articles · Source identity article-effect"
      );
      expect(result.stdout).toContain(
        "MissingAuthor: Could not resolve the article author"
      );
      expect(result.stdout).toContain("Author lookup returned no result");
      expect(result.stdout).toContain('"authorId": "author-missing"');
      expect(result.stdout).not.toContain("author-ada");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("prints grouped durable messages as schema-valid JSON", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("messages.config.ts")
      );

      const result = yield* runCli(
        [
          "messages",
          "--config",
          "migrate.config.ts",
          "--group",
          "content",
          "--json",
        ],
        project
      );
      const messages = yield* Schema.decodeUnknownEffect(
        MigrationMessagesFromJson
      )(result.stdout);

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(messages).toHaveLength(3);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("articles"),
            details: { authorId: "author-missing" },
            kind: "process-diagnostic",
            sourceIdentity: "article-effect",
          }),
          expect.objectContaining({
            definitionId: toMigrationDefinitionId("authors"),
            kind: "skip-reason",
            message: "Author already exists at the destination",
            sourceIdentity: "author-ada",
          }),
        ])
      );
      expect(messages[0]?.updatedAt).toBeInstanceOf(Date);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("breaks a selected Migration Definition lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        lockedStoreConfigSource()
      );

      const result = yield* runCli(
        ["unlock", "--config", "migrate.config.ts", "articles"],
        project
      );
      const probe = getExecutionProbe();

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Migration Definition lock cleared");
      expect(result.stdout).toContain("Migration ID  articles");
      expect(result.stdout).toContain("Owner Run ID  run-stuck");
      expect(result.stdout).toContain("Token         lock-stuck");
      expect(probe.storeState.definitionLocks.size).toBe(0);

      const secondResult = yield* runCli(
        ["unlock", "--config", "migrate.config.ts", "articles"],
        project
      );

      expect(secondResult.stderr).toBe("");
      expect(secondResult.cause).toBe("");
      expect(secondResult.exitCode).toBe(0);
      expect(secondResult.stdout).toContain(
        "Migration Definition lock is already clear: articles"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects unlocking an unknown Migration Definition", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        lockedStoreConfigSource()
      );

      const result = yield* runCli(
        ["unlock", "--config", "migrate.config.ts", "missing"],
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

  it.effect(
    "renders status missing dependency suggestions without plan flags",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = yield* makeProject;

        yield* fs.writeFileString(
          `${project}/migrate.config.ts`,
          planConfigSource()
        );

        const result = yield* runCli(
          ["status", "--config", "migrate.config.ts", "articles"],
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
          "migrate status --with-dependencies articles"
        );
        expect(result.stderr).toContain("migrate status authors articles");
        expect(result.stderr).not.toContain("--plan");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects status concurrency without source scanning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status.config.ts")
      );

      const result = yield* runCli(
        [
          "status",
          "--config",
          "migrate.config.ts",
          "--concurrency",
          "2",
          "articles",
        ],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Status concurrency is only valid when source scanning is enabled"
      );
      expect(result.stderr).not.toContain("MigrationStatusRequestError");
      expect(result.stdout).toBe("");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects non-positive status source-scan concurrency", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status.config.ts")
      );

      const result = yield* runCli(
        [
          "status",
          "--config",
          "migrate.config.ts",
          "--scan-source",
          "--concurrency",
          "0",
          "articles",
        ],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Status concurrency must be a positive integer"
      );
      expect(result.stderr).not.toContain("MigrationStatusRequestError");
      expect(result.stdout).toBe("");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("does not accept source identity targets for status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status.config.ts")
      );

      const result = yield* runCli(
        [
          "status",
          "--config",
          "migrate.config.ts",
          "--id",
          "article-1",
          "articles",
        ],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(`${result.stderr}\n${result.cause}`).toContain("--id");
      expect(result.stdout).toContain("USAGE");
      expect(result.stdout).not.toContain("Migration Status");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders source-scan status counts and warnings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        yield* readCliFixture("status-scan.config.ts")
      );

      const result = yield* runCli(
        [
          "status",
          "--config",
          "migrate.config.ts",
          "--scan-source",
          "-c",
          "2",
          "articles",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Total");
      expect(result.stdout).toContain("Unprocessed");
      expect(result.stdout).toContain("Invalid");
      expect(result.stdout).toContain("Duplicate");
      expect(result.stdout).toContain("Orphaned");
      expect(result.stdout).toContain("articles");
      expect(result.stdout).toContain("failed");
      expect(result.stdout).not.toContain("Pass --scan-source");
      expect(result.stdout).toContain("Warnings:");
      expect(result.stdout).toContain(
        "Invalid source item in articles: article-invalid"
      );
      expect(result.stdout).toContain(
        "Duplicate source identity in articles: article-new"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it("colorizes rendered status severity when colors are enabled", () => {
    const output = renderStatusReport(
      {
        definitions: [
          {
            definitionId: "articles",
            discovery: "full",
            durable: {
              failed: 0,
              migrated: 1,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: { status: "succeeded" },
            lock: null,
            source: {
              duplicate: 0,
              invalid: 0,
              orphaned: 0,
              total: 2,
              unprocessed: 1,
            },
          },
        ],
        includedDefinitionIds: ["articles"],
        notices: [],
        requestedDefinitionIds: ["articles"],
        scanSource: true,
        warnings: [],
      } as never,
      { colors: true }
    );

    expect(output).toContain("\x1b[36mpending");
    expect(output).toContain("\x1b[32msucceeded");
  });

  it("renders lock state separately from latest run state", () => {
    const activeDefinitionId = toMigrationDefinitionId("active");
    const staleDefinitionId = toMigrationDefinitionId("stale");
    const output = renderStatusReport(
      {
        definitions: [
          {
            definitionId: activeDefinitionId,
            discovery: "full",
            durable: {
              failed: 0,
              migrated: 1,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: { status: "running" },
            lock: {
              createdAt: new Date("2026-06-23T00:00:00.000Z"),
              definitionId: activeDefinitionId,
              ownerRunId: toMigrationRunId("run-active"),
              token: toMigrationDefinitionLockToken("lock-active"),
            },
            warnings: [],
          },
          {
            definitionId: staleDefinitionId,
            discovery: "full",
            durable: {
              failed: 0,
              migrated: 1,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: { status: "running" },
            lock: null,
            warnings: [],
          },
        ],
        includedDefinitionIds: [activeDefinitionId, staleDefinitionId],
        notices: [],
        requestedDefinitionIds: [activeDefinitionId, staleDefinitionId],
        scanSource: false,
        warnings: [],
      } as never,
      { colors: false }
    );

    expect(output).toContain("Lock");
    expect(output).toMatch(activeLockedStatusRowPattern);
    expect(output).toMatch(staleRunningStatusRowPattern);
  });

  it("renders named source identity parts in duplicate status warnings", () => {
    const definitionId = toMigrationDefinitionId("business-addresses");
    const output = renderStatusReport(
      {
        definitions: [
          {
            definitionId,
            discovery: "full",
            durable: {
              failed: 0,
              migrated: 0,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: null,
            lock: null,
            source: {
              duplicate: 1,
              invalid: 0,
              orphaned: 0,
              total: 2,
              unprocessed: 1,
            },
            warnings: [],
          },
        ],
        includedDefinitionIds: [definitionId],
        notices: [],
        requestedDefinitionIds: [definitionId],
        scanSource: true,
        warnings: [
          new DuplicateSourceIdentityStatusWarning({
            count: 1,
            definitionId,
            sourceIdentity: toEncodedSourceIdentity('["bu-1",0]'),
            sourceIdentityParts: [
              {
                name: "businessUnitKey",
                value: "bu-1",
              },
              {
                name: "addressIndex",
                value: 0,
              },
            ],
          }),
        ],
      },
      { colors: false }
    );

    expect(output).toContain(
      'Duplicate source identity in business-addresses: ["bu-1",0] (businessUnitKey=bu-1, addressIndex=0)'
    );
  });

  it.effect("reports and explicitly upgrades SQL Migration Store schemas", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      const configPath = `${project}/migrate.config.ts`;
      const databasePath = `${project}/migration-state.sqlite`;

      yield* fs.writeFileString(
        configPath,
        sqlStoreSchemaConfigSource(databasePath)
      );

      const firstStatus = yield* runCli(
        [
          "store",
          "schema",
          "status",
          "--config",
          "migrate.config.ts",
          "--json",
        ],
        project
      );
      expect(firstStatus).toEqual(
        expect.objectContaining({ exitCode: 0, stderr: "" })
      );
      const initialPlan = decodeCliSchemaPlan(firstStatus.stdout);
      const repeatedStatus = yield* runCli(
        [
          "store",
          "schema",
          "status",
          "--config",
          "migrate.config.ts",
          "--json",
        ],
        project
      );
      const repeatedPlan = decodeCliSchemaPlan(repeatedStatus.stdout);

      expect(initialPlan).toEqual(
        expect.objectContaining({
          currentVersion: null,
          status: "not-installed",
          tablePrefix: "cli_schema",
          targetVersion: 2,
        })
      );
      expect(repeatedPlan).toEqual(initialPlan);

      const unapproved = yield* runCli(
        ["store", "schema", "upgrade", "--config", "migrate.config.ts"],
        project
      );
      expect(unapproved.exitCode).toBe(1);
      expect(unapproved.stderr).toContain(
        `Schema upgrade requires --accept-plan ${initialPlan.planId} in non-interactive mode`
      );

      const upgraded = yield* runCli(
        [
          "store",
          "schema",
          "upgrade",
          "--config",
          "migrate.config.ts",
          "--accept-plan",
          initialPlan.planId,
          "--json",
        ],
        project
      );
      const currentPlan = decodeCliSchemaPlan(upgraded.stdout);

      expect(upgraded.exitCode).toBe(0);
      expect(upgraded.stderr).toBe("");
      expect(currentPlan).toEqual(
        expect.objectContaining({
          currentVersion: 2,
          status: "current",
          tablePrefix: "cli_schema",
          targetVersion: 2,
        })
      );

      const repeatedUpgrade = yield* runCli(
        [
          "store",
          "schema",
          "upgrade",
          "--config",
          "migrate.config.ts",
          "--accept-plan",
          initialPlan.planId,
          "--json",
        ],
        project
      );

      expect(repeatedUpgrade).toEqual(
        expect.objectContaining({ exitCode: 0, stderr: "" })
      );
      expect(decodeCliSchemaPlan(repeatedUpgrade.stdout)).toEqual(currentPlan);

      const finalStatus = yield* runCli(
        [
          "store",
          "schema",
          "status",
          "--config",
          "migrate.config.ts",
          "--json",
        ],
        project
      );
      expect(decodeCliSchemaPlan(finalStatus.stdout)).toEqual(currentPlan);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("defaults interactive schema upgrade confirmation to no", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      const confirmations: string[] = [];

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        sqlStoreSchemaConfigSource(`${project}/declined.sqlite`)
      );

      const result = yield* runCliWithRuntime(
        ["store", "schema", "upgrade", "--config", "migrate.config.ts"],
        project,
        {
          confirmSchemaUpgrade: (plan) =>
            Effect.sync(() => {
              confirmations.push(plan.planId);
              return false;
            }),
          stdoutIsTTY: true,
        }
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Schema upgrade cancelled.");
      expect(confirmations).toHaveLength(1);

      const status = yield* runCli(
        [
          "store",
          "schema",
          "status",
          "--config",
          "migrate.config.ts",
          "--json",
        ],
        project
      );
      expect(status).toEqual(
        expect.objectContaining({ exitCode: 0, stderr: "" })
      );
      expect(decodeCliSchemaPlan(status.stdout)).toEqual(
        expect.objectContaining({ status: "not-installed" })
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("requires an explicit SQL store target for schema commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        configSource("articles")
      );

      const result = yield* runCli(
        ["store", "schema", "status", "--config", "migrate.config.ts"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "SQL Migration Store schema commands require sqlStore in defineMigrationCliConfig"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders the store schema command hierarchy in help", () =>
    Effect.gen(function* () {
      const project = yield* makeProject;
      const result = yield* runCli(["store", "schema", "--help"], project);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(
        "USAGE\n  migrate store schema <subcommand> [flags]"
      );
      expect(result.stdout).toContain("status");
      expect(result.stdout).toContain("upgrade");
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

  it.effect(
    "runs list through the package bin",
    () =>
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
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer)),
    10_000
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
          "Migration config must be created with defineMigrationCliConfig({ registry, executableLayer?, sqlStore? })"
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
        expect(output).toContain("Failed to import migration config");
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
        expect(result.stderr).toContain("Failed to import migration config");
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
          import {
            MigrationDefinition,
            MigrationDefinitionRegistry,
            SourceIdentity,
          } from "migrate-sdk";
          import {
            InMemorySource,
          } from "migrate-sdk/sources/in-memory";
          import {
            InMemoryMigrationStore,
          } from "migrate-sdk/stores/in-memory";
          import { Schema } from "effect";
          import { defineMigrationCliConfig } from "migrate-sdk/cli";

          ${tsDefinitionFixtureSource()}

          export default defineMigrationCliConfig({
            registry: MigrationDefinitionRegistry.make({
              definitions: [
                definition("articles", { dependencies: { required: ["authors"], optional: [] } }),
                definition("articles", { dependencies: { required: ["images"], optional: [] } })
              ]
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
        "Migration config must be exported as the default export"
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
          import {
            MigrationDefinition,
            MigrationDefinitionRegistry,
            SourceIdentity,
          } from "migrate-sdk";
          import {
            InMemorySource,
          } from "migrate-sdk/sources/in-memory";
          import {
            InMemoryMigrationStore,
          } from "migrate-sdk/stores/in-memory";
          import { Schema } from "effect";

          ${tsDefinitionFixtureSource()}

          export const registry = MigrationDefinitionRegistry.make({
            definitions: [definition("relative-import")]
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
      expect(result.stderr).toContain("No migration config was found");
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
      expect(result.stderr).toContain("No migration config was found");
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
      expect(result.stderr).toContain("Migration config must be synchronous");
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
