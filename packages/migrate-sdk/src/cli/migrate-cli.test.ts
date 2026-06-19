import { fileURLToPath } from "node:url";
import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Stdio, Stream } from "effect";
import { pretty as prettyCause } from "effect/Cause";
import { isFailure, isSuccess } from "effect/Exit";
import { TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  DuplicateSourceIdentityStatusWarning,
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { MigrationCliRuntime, migrateCommand } from "migrate-sdk/cli/testing";
import { renderStatusReport } from "./render.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binPath = fileURLToPath(
  new URL("../../bin/migrate-sdk.mjs", import.meta.url)
);

const tagsAuthorsArticlesOrderPattern =
  /1\s+tags[\s\S]*2\s+authors[\s\S]*3\s+articles/;
const singleTagsRowPattern = /1\s+tags/;
const articlesAuthorsOrderPattern = /1\s+articles[\s\S]*2\s+authors/;
const authorsArticlesOrderPattern = /1\s+authors[\s\S]*2\s+articles/;
const articlesAuthorsTagsOrderPattern =
  /1\s+articles[\s\S]*2\s+authors[\s\S]*3\s+tags/;
const selectedRunSummaryPattern =
  /1\s+authors\s+succeeded\s+1\s+0\s+0\s+0\s+0[\s\S]*2\s+articles\s+succeeded\s+1\s+0\s+0\s+0\s+0/;
const articleRunSummaryPattern = /1\s+articles\s+succeeded\s+1\s+0\s+0\s+0\s+0/;
const rollbackAllSummaryPattern =
  /1\s+articles\s+succeeded\s+1\s+0\s+0[\s\S]*2\s+authors\s+succeeded\s+1\s+0\s+0[\s\S]*3\s+tags\s+succeeded\s+1\s+0\s+0/;
const tagRollbackSummaryPattern = /1\s+tags\s+succeeded\s+1\s+0\s+0/;
const tagsProcessConcurrencyPattern = /tags\s+4/;
const authorsProcessConcurrencyPattern = /authors\s+4/;
const tagsRollbackConcurrencyPattern = /tags\s+unbounded/;

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
  import { MigrationDefinitionRegistry, SourceIdentity, toMigrationDefinitionId } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";
  import { Schema } from "effect";

  const identity = SourceIdentity.make({
    id: "plan-fixture@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });

  const definition = (id: string, input: Record<string, unknown> = {}) => ({
    id: toMigrationDefinitionId(id),
    source: { identity },
    process: () => {
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
    rollback: () => undefined
  });
  const tags = definition("tags", {
    rollback: () => undefined
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

const statusConfigSource = (): string => `
  import { Schema } from "effect";
  import {
    defineMigration,
    InMemoryMigrationStore,
    InMemorySourcePlugin,
    MigrationDefinitionRegistry,
    SourceIdentity,
    toMigrationDefinitionId,
    toMigrationRunId,
    toEncodedSourceIdentity,
    toSourceVersion
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const definitionId = toMigrationDefinitionId("articles");
  const storeState = InMemoryMigrationStore.makeState();
  const runId = toMigrationRunId("run-status");
  const updatedAt = new Date("2026-01-01T00:00:02.000Z");
  const store = InMemoryMigrationStore.layer(storeState);

  storeState.latestRunStates.set(definitionId, {
    definitionIds: [definitionId],
    finishedAt: new Date("2026-01-01T00:00:01.000Z"),
    runId,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    status: "succeeded"
  });
  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey(definitionId, "article-1"),
    {
      definitionId,
      lastRunId: runId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-1"),
      sourceVersion: toSourceVersion("source-version-1"),
      status: "migrated",
      updatedAt
    }
  );
  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey(definitionId, "article-2"),
    {
      definitionId,
      lastRunId: runId,
      skipReason: "Draft article",
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-2"),
      sourceVersion: toSourceVersion("source-version-1"),
      status: "skipped",
      updatedAt
    }
  );

  const articles = defineMigration({
    id: definitionId,
    source: InMemorySourcePlugin.make({
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

const statusScanConfigSource = (): string => `
  import { Schema } from "effect";
  import {
    defineMigration,
    InMemoryMigrationStore,
    InMemorySourcePlugin,
    MigrationDefinitionRegistry,
    SourceIdentity,
    toMigrationDefinitionId,
    toMigrationRunId,
    toEncodedSourceIdentity,
    toSourceVersion
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const definitionId = toMigrationDefinitionId("articles");
  const storeState = InMemoryMigrationStore.makeState();
  const runId = toMigrationRunId("run-status");
  const updatedAt = new Date("2026-01-01T00:00:02.000Z");
  const store = InMemoryMigrationStore.layer(storeState);

  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey(definitionId, "article-1"),
    {
      definitionId,
      lastRunId: runId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-1"),
      sourceVersion: toSourceVersion("source-version-1"),
      status: "migrated",
      updatedAt
    }
  );
  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey(definitionId, "article-orphan"),
    {
      definitionId,
      lastRunId: runId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-orphan"),
      sourceVersion: toSourceVersion("source-version-1"),
      status: "migrated",
      updatedAt
    }
  );

  const articles = defineMigration({
    id: definitionId,
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: [
        {
          identityKey: "article-1",
          version: "source-version-1",
          item: { title: "Already migrated" }
        },
        {
          identityKey: "article-new",
          version: "source-version-1",
          item: { title: "New article" }
        },
        {
          identityKey: "article-new",
          version: "source-version-2",
          item: { title: "Duplicate article" }
        },
        {
          identityKey: "article-invalid",
          version: "source-version-1",
          item: {}
        }
      ]
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
  readonly executions: string[];
  readonly storeState: {
    readonly definitionLocks: Map<unknown, unknown>;
    readonly latestRunStates: Map<unknown, unknown>;
  };
}

const executionProbeGlobal = "__migrateSdkCliExecutionProbe";

const resetExecutionProbe = () => {
  delete (globalThis as Record<string, unknown>)[executionProbeGlobal];
};

const getExecutionProbe = (): CliExecutionProbe => {
  const probe = (globalThis as Record<string, unknown>)[executionProbeGlobal];

  if (typeof probe !== "object" || probe === null) {
    throw new Error("CLI execution probe was not initialized");
  }

  return probe as CliExecutionProbe;
};

const executionConfigSource = (): string => `
  import { Schema } from "effect";
  import {
    defineMigration,
    InMemoryMigrationStore,
    InMemorySourcePlugin,
    MigrationDefinitionRegistry,
    SourceIdentity,
    toMigrationDefinitionId
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const probe = {
    executions: [],
    storeState
  };

  globalThis.${executionProbeGlobal} = probe;

  const definition = (id, title, input = {}) => defineMigration({
    id: toMigrationDefinitionId(id),
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: [{
        identityKey: id + "-1",
        version: "source-version-1",
        item: { title }
      }]
    }),
    store,
    process: () => {
      probe.executions.push(id);
    },
    ...input
  });

  const authors = definition("authors", "Author");
  const articles = definition("articles", "Article", {
    dependencies: {
      required: [toMigrationDefinitionId("authors")],
      optional: [toMigrationDefinitionId("tags")]
    }
  });
  const tags = definition("tags", "Tag");

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [tags, articles, authors]
    })
  });
`;

const modeExecutionConfigSource = (): string => `
  import { Schema } from "effect";
  import {
    defaultSourceVersionContractFingerprint,
    defineMigration,
    InMemoryMigrationStore,
    InMemorySourcePlugin,
    MigrationDefinitionRegistry,
    SourceIdentity,
    toMigrationDefinitionId,
    toMigrationRunId,
    toEncodedSourceIdentity,
    toSourceVersion
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const definitionId = toMigrationDefinitionId("articles");
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const probe = {
    executions: [],
    storeState
  };

  globalThis.${executionProbeGlobal} = probe;

  const previousRunId = toMigrationRunId("run-previous");
  const previousDate = new Date("2026-01-01T00:00:00.000Z");

  storeState.migrationContracts.set(definitionId, {
    definitionId,
    sourceIdentityContractFingerprint: EntrySourceIdentity.fingerprint,
    sourceVersionContractFingerprint: defaultSourceVersionContractFingerprint
  });

  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey("articles", "article-failed"),
    {
      definitionId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-failed"),
      sourceVersion: toSourceVersion("source-version-1"),
      lastRunId: previousRunId,
      updatedAt: previousDate,
      status: "failed",
      error: {
        kind: "destination",
        errorTag: "DestinationPluginError",
        message: "destination effect failed"
      }
    }
  );
  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey("articles", "article-skipped"),
    {
      definitionId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-skipped"),
      sourceVersion: toSourceVersion("source-version-1"),
      lastRunId: previousRunId,
      updatedAt: previousDate,
      status: "skipped",
      skipReason: "Draft article"
    }
  );
  storeState.itemStates.set(
    InMemoryMigrationStore.itemStateKey("articles", "article-target"),
    {
      definitionId,
      sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, "article-target"),
      sourceVersion: toSourceVersion("source-version-1"),
      lastRunId: previousRunId,
      updatedAt: previousDate,
      status: "migrated"
    }
  );

  const articles = defineMigration({
    id: definitionId,
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: [
        {
          identityKey: "article-failed",
          version: "source-version-1",
          item: { title: "Failed article" }
        },
        {
          identityKey: "article-skipped",
          version: "source-version-1",
          item: { title: "Skipped article" }
        },
        {
          identityKey: "article-target",
          version: "source-version-1",
          item: { title: "Target article" }
        },
        {
          identityKey: "article-new",
          version: "source-version-1",
          item: { title: "New article" }
        }
      ]
    }),
    store,
    process: (sourceItem) => {
      probe.executions.push(sourceItem.identity.encoded);
    }
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [articles]
    })
  });
`;

const rollbackExecutionConfigSource = (): string => `
  import { Schema } from "effect";
  import {
    defineMigration,
    InMemoryMigrationStore,
    InMemorySourcePlugin,
    MigrationDefinitionRegistry,
    SourceIdentity,
    toMigrationDefinitionId,
    toMigrationRunId,
    toEncodedSourceIdentity,
    toSourceVersion
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const storeState = InMemoryMigrationStore.makeState();
  const store = InMemoryMigrationStore.layer(storeState);
  const probe = {
    executions: [],
    storeState
  };

  globalThis.${executionProbeGlobal} = probe;

  const previousRunId = toMigrationRunId("run-previous");
  const previousDate = new Date("2026-01-01T00:00:00.000Z");
  const seedMigratedState = (id, identity) => {
    const definitionId = toMigrationDefinitionId(id);
    storeState.itemStates.set(
      InMemoryMigrationStore.itemStateKey(definitionId, identity),
      {
        definitionId,
        sourceIdentity: SourceIdentity.fromKey(EntrySourceIdentity, identity),
        sourceVersion: toSourceVersion("source-version-1"),
        lastRunId: previousRunId,
        updatedAt: previousDate,
        status: "migrated"
      }
    );
  };

  seedMigratedState("tags", "tags-1");
  seedMigratedState("authors", "authors-1");
  seedMigratedState("articles", "articles-1");

  const definition = (id, identity, input = {}) => defineMigration({
    id: toMigrationDefinitionId(id),
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      items: [{
        identityKey: identity,
        version: "source-version-1",
        item: { title: id }
      }]
    }),
    store,
    process: () => undefined,
    rollback: () => {
      probe.executions.push("rollback:" + id);
    },
    ...input
  });

  const authors = definition("authors", "authors-1");
  const articles = definition("articles", "articles-1", {
    dependencies: {
      required: [toMigrationDefinitionId("authors")],
      optional: [toMigrationDefinitionId("tags")]
    }
  });
  const tags = definition("tags", "tags-1");

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [tags, articles, authors]
    })
  });
`;

const runtimeFailureConfigSource = (): string => `
  import { Schema } from "effect";
  import {
    defineMigration,
    InMemoryMigrationStore,
    InMemorySourcePlugin,
    MigrationDefinitionRegistry,
    SourceIdentity,
    toMigrationDefinitionId
  } from "migrate-sdk";
  import { defineMigrationCliConfig } from "migrate-sdk/cli";

  const EntrySource = Schema.Struct({ title: Schema.String });
  const EntrySourceIdentity = SourceIdentity.make({
    id: "entry@v1",
    schema: SourceIdentity.key("id", Schema.NonEmptyString)
  });
  const articles = defineMigration({
    id: toMigrationDefinitionId("articles"),
    source: InMemorySourcePlugin.make({
      identity: EntrySourceIdentity,
      sourceSchema: EntrySource,
      batchSize: 0,
      items: [{
        identityKey: "article-1",
        version: "source-version-1",
        item: { title: "Article" }
      }]
    }),
    store: InMemoryMigrationStore.layer(),
    process: () => undefined
  });

  export default defineMigrationCliConfig({
    registry: MigrationDefinitionRegistry.make({
      definitions: [articles]
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
            rollback: () => undefined
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
        expect(result.stdout).toContain("Migration ID");
        expect(result.stdout).toContain("Rollback");
        expect(result.stdout).toContain("Required");
        expect(result.stdout).toContain("Optional");
        expect(result.stdout).toContain("authors");
        expect(result.stdout).toContain("articles");
        expect(result.stdout).toContain("yes");
        expect(result.stdout).toContain("authors");
        expect(result.stdout).toContain("images (unresolved)");
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

  it.effect("renders durable-only status for explicit definitions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        statusConfigSource()
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

  it.effect("requires an explicit status scope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        statusConfigSource()
      );

      const result = yield* runCli(
        ["status", "--config", "migrate.config.ts"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Registry planning requires all: true or at least one Migration Definition id"
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
        statusConfigSource()
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
        statusConfigSource()
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
        statusConfigSource()
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
        statusConfigSource()
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
        statusScanConfigSource()
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
            durable: {
              failed: 0,
              migrated: 1,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: { status: "succeeded" },
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

  it("renders named source identity parts in duplicate status warnings", () => {
    const definitionId = toMigrationDefinitionId("business-addresses");
    const output = renderStatusReport(
      {
        definitions: [
          {
            definitionId,
            durable: {
              failed: 0,
              migrated: 0,
              needsUpdate: 0,
              skipped: 0,
            },
            lastRun: null,
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
            "-c",
            "4",
            "--with-dependencies",
            "articles",
            "tags",
          ],
          project
        );

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Run Plan");
        expect(result.stdout).toContain("Requested  articles, tags");
        expect(result.stdout).toContain("Included   tags, articles, authors");
        expect(result.stdout).toContain("Execution Order");
        expect(result.stdout).toContain("Execution Policy");
        expect(result.stdout).toContain("Process Concurrency");
        expect(result.stdout).toMatch(tagsProcessConcurrencyPattern);
        expect(result.stdout).toMatch(authorsProcessConcurrencyPattern);
        expect(result.stdout).toMatch(tagsAuthorsArticlesOrderPattern);
        expect(result.stdout).not.toContain("executed");
      }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders a rollback plan with source identity targets", () =>
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
          "--concurrency",
          "unbounded",
          "--id",
          "article-1",
          "--id",
          "article-2",
          "tags",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rollback Plan");
      expect(result.stdout).toContain("Requested  tags");
      expect(result.stdout).toContain(
        "Target source identities article-1, article-2"
      );
      expect(result.stdout).toContain("Included   tags");
      expect(result.stdout).toMatch(singleTagsRowPattern);
      expect(result.stdout).toContain("Execution Policy");
      expect(result.stdout).toContain("Rollback Concurrency");
      expect(result.stdout).toMatch(tagsRollbackConcurrencyPattern);
      expect(result.stdout).not.toContain("executed");
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects invalid pipeline execution concurrency flags", () =>
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
          "--concurrency",
          "0",
          "tags",
        ],
        project
      );
      const rollbackResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "-c",
          "1.5",
          "tags",
        ],
        project
      );

      expect(runResult.exitCode).toBe(1);
      expect(runResult.stdout).toBe("");
      expect(runResult.stderr).toContain(
        '--concurrency must be a positive integer or "unbounded"'
      );
      expect(rollbackResult.exitCode).toBe(1);
      expect(rollbackResult.stdout).toBe("");
      expect(rollbackResult.stderr).toContain(
        '--concurrency must be a positive integer or "unbounded"'
      );
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
        expect(result.stdout).toContain("Requested  authors, articles");
        expect(result.stdout).toContain("Included   articles, authors");
        expect(result.stdout).toMatch(articlesAuthorsOrderPattern);
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
      expect(result.stdout).toContain("Run Plan");
      expect(result.stdout).toContain("Requested  articles, articles, tags");
      expect(result.stdout).toContain(
        "Notices:\n! Duplicate requested definition ignored: articles"
      );
      expect(result.stdout).toContain(
        "! Ignored optional dependency cycle: articles -> tags -> articles"
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
            "--id",
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
            "--id",
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
      expect(result.stdout).toContain("Run Plan");
      expect(result.stdout).toContain("Mode       failed");
      expect(result.stdout).toMatch(singleTagsRowPattern);
      expect(skippedResult.stderr).toBe("");
      expect(skippedResult.exitCode).toBe(0);
      expect(skippedResult.stdout).toContain("Mode       skipped");
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
      expect(result.stdout).toContain("Included   articles, authors");
      expect(result.stdout).not.toContain("Included   tags, articles, authors");
      expect(result.stdout).toMatch(authorsArticlesOrderPattern);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect(
    "parses source identity targets and renders duplicate target notices",
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
            "--id",
            "article%2C1",
            "--id",
            "article-2",
            "--id",
            "article%2C1",
            "tags",
          ],
          project
        );

        expect(result.stderr).toBe("");
        expect(result.cause).toBe("");
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain(
          "Target source identities article,1, article-2"
        );
        expect(result.stdout).toContain(
          "Notices:\n! Duplicate source identity target ignored: article,1"
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

      const emptyIdResult = yield* runCli(
        [
          "rollback",
          "--config",
          "migrate.config.ts",
          "--plan",
          "--id",
          "",
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
          "--id",
          "article-%E0%A4%A",
          "tags",
        ],
        project
      );

      expect(emptyIdResult.exitCode).toBe(1);
      expect(emptyIdResult.stderr).toContain("--id must not be empty");
      expect(emptyIdResult.stderr).not.toContain(
        "Migration Definition selection is missing required dependencies"
      );
      expect(invalidEncodingResult.exitCode).toBe(1);
      expect(invalidEncodingResult.stderr).toContain(
        "--id contains invalid percent encoding"
      );
      expect(invalidEncodingResult.stderr).not.toContain(
        "Migration Definition selection is missing required dependencies"
      );
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders run item source identity targets", () =>
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
          "--id",
          "article%2C1",
          "tags",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run Plan");
      expect(result.stdout).toContain("Requested  tags");
      expect(result.stdout).toContain("Target source identities article,1");
      expect(result.stdout).toMatch(singleTagsRowPattern);
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
          "--id",
          "article-1",
          "--id",
          "article-2",
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
          "--id",
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
          "--id",
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
          "--id",
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
          "--id",
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
          "--id",
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
          "--id",
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
          "--id",
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
          "--id",
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
      expect(runAllResult.stdout).toContain("Requested  all");
      expect(runAllResult.stdout).toContain(
        "Included   tags, articles, authors"
      );
      expect(runAllResult.stdout).toMatch(tagsAuthorsArticlesOrderPattern);
      expect(rollbackAllResult.stderr).toBe("");
      expect(rollbackAllResult.exitCode).toBe(0);
      expect(rollbackAllResult.stdout).toContain("Requested  all");
      expect(rollbackAllResult.stdout).toMatch(articlesAuthorsTagsOrderPattern);
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

  it.effect("executes selected run definitions in dependency order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      resetExecutionProbe();

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        executionConfigSource()
      );

      const result = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--with-dependencies",
          "articles",
          "articles",
        ],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run Completed succeeded");
      expect(result.stdout).toContain("Migration ID");
      expect(result.stdout).toContain("Needs Update");
      expect(result.stdout).toMatch(selectedRunSummaryPattern);
      expect(result.stdout).not.toContain("tags          succeeded");
      expect(getExecutionProbe().executions).toEqual(["authors", "articles"]);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("executes all run definitions in dependency order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      resetExecutionProbe();

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        executionConfigSource()
      );

      const result = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--all"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Run Completed succeeded");
      expect(getExecutionProbe().executions).toEqual([
        "tags",
        "authors",
        "articles",
      ]);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("executes failed, skipped, and source identity run modes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      resetExecutionProbe();

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        modeExecutionConfigSource()
      );

      const failedResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--failed", "articles"],
        project
      );
      const skippedResult = yield* runCli(
        ["run", "--config", "migrate.config.ts", "--skipped", "articles"],
        project
      );
      const itemResult = yield* runCli(
        [
          "run",
          "--config",
          "migrate.config.ts",
          "--id",
          "article-target",
          "articles",
        ],
        project
      );

      expect(failedResult.stderr).toBe("");
      expect(failedResult.exitCode).toBe(0);
      expect(failedResult.stdout).toContain("Run Completed succeeded");
      expect(failedResult.stdout).toMatch(articleRunSummaryPattern);
      expect(skippedResult.stderr).toBe("");
      expect(skippedResult.exitCode).toBe(0);
      expect(itemResult.stderr).toBe("");
      expect(itemResult.exitCode).toBe(0);
      expect(getExecutionProbe().executions).toEqual([
        "article-failed",
        "article-skipped",
        "article-target",
      ]);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("executes rollback definitions in reverse dependency order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      resetExecutionProbe();

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        rollbackExecutionConfigSource()
      );

      const result = yield* runCli(
        ["rollback", "--config", "migrate.config.ts", "--all"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rollback Completed succeeded");
      expect(result.stdout).toMatch(rollbackAllSummaryPattern);
      expect(getExecutionProbe().executions).toEqual([
        "rollback:articles",
        "rollback:authors",
        "rollback:tags",
      ]);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("executes targeted rollback source identities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      resetExecutionProbe();

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        rollbackExecutionConfigSource()
      );

      const result = yield* runCli(
        ["rollback", "--config", "migrate.config.ts", "--id", "tags-1", "tags"],
        project
      );

      expect(result.stderr).toBe("");
      expect(result.cause).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rollback Completed succeeded");
      expect(result.stdout).toMatch(tagRollbackSummaryPattern);
      expect(result.stdout).not.toContain("authors       succeeded");
      expect(getExecutionProbe().executions).toEqual(["rollback:tags"]);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("rejects invalid execution selections before runtime work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;
      resetExecutionProbe();

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        executionConfigSource()
      );

      const result = yield* runCli(
        ["run", "--config", "migrate.config.ts", "articles"],
        project
      );
      const probe = getExecutionProbe();

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Migration Definition selection is missing required dependencies"
      );
      expect(result.stderr).not.toContain("Run completed");
      expect(probe.executions).toEqual([]);
      expect(probe.storeState.latestRunStates.size).toBe(0);
      expect(probe.storeState.definitionLocks.size).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(nodeServicesLayer))
  );

  it.effect("renders structured runtime failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const project = yield* makeProject;

      yield* fs.writeFileString(
        `${project}/migrate.config.ts`,
        runtimeFailureConfigSource()
      );

      const result = yield* runCli(
        ["run", "--config", "migrate.config.ts", "articles"],
        project
      );

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SourcePluginError");
      expect(result.stderr).toContain(
        "In-memory source batchSize must be a positive integer"
      );
      expect(result.stderr).not.toContain("CliError/UserError");
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
