import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Stdio, Stream } from "effect";
import { pretty as prettyCause } from "effect/Cause";
import { isFailure, isSuccess } from "effect/Exit";
import { TestConsole } from "effect/testing";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  toEncodedSourceIdentity,
  toMigrationDefinitionId,
  toMigrationDefinitionLockToken,
  toMigrationRunId,
} from "../domain/ids.ts";
import { MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError } from "../domain/registry.ts";
import { MigrationStatusRequestError } from "../domain/status.ts";
import {
  MigrateDashboardResumeToken,
  type MigrateRegistryStatusRequest,
} from "../protocol/index.ts";
import { migrateCommand } from "./command.ts";
import {
  MigrationCliRuntime,
  type MigrationCliRuntimeShape,
  type MigrationCliServerConnection,
} from "./runtime.ts";

const authorsId = toMigrationDefinitionId("authors");
const articlesId = toMigrationDefinitionId("articles");
const runId = toMigrationRunId("run-remote");
const lock = {
  createdAt: new Date("2026-08-29T11:00:00.000Z"),
  definitionId: articlesId,
  ownerRunId: runId,
  token: toMigrationDefinitionLockToken("lock-remote"),
};
const authorsEntry = {
  dependencies: { optional: [], required: [] },
  hasRollback: true,
  id: authorsId,
};
const articlesEntry = {
  dependencies: { optional: [], required: [authorsId] },
  hasRollback: true,
  id: articlesId,
};
const registry = {
  entries: [authorsEntry, articlesEntry],
  groups: [],
};
const articlesStatus = {
  definitionId: articlesId,
  discovery: "full" as const,
  durable: { failed: 0, migrated: 3, needsUpdate: 0, skipped: 1 },
  lastRun: null,
  lock,
  source: {
    duplicate: 0,
    invalid: 0,
    orphaned: 0,
    total: 5,
    unprocessed: 2,
  },
  warnings: [],
};

const makeConnection = (
  overrides: Partial<MigrationCliServerConnection> = {}
): MigrationCliServerConnection => ({
  breakLock: () => Effect.die("Unexpected lock break"),
  dispose: () => Promise.resolve(),
  getActiveRuns: Effect.succeed([]),
  getDashboard: Effect.succeed({
    dashboard: {
      activeRuns: [],
      groups: [],
      rows: [],
      scannedSource: false,
    },
    resumeToken: MigrateDashboardResumeToken.make("dashboard-empty"),
  }),
  getRegistry: Effect.succeed(registry),
  getRegistryMessages: () =>
    Effect.succeed({
      includedDefinitionIds: [],
      messages: [],
      notices: [],
      requestedDefinitionIds: [],
    }),
  getRegistryStatus: () =>
    Effect.succeed({
      definitions: [],
      includedDefinitionIds: [],
      notices: [],
      requestedDefinitionIds: [],
      scanSource: false,
      warnings: [],
    }),
  observeRun: () => Stream.die("Unexpected run observation"),
  prepareOperation: () => Effect.die("Unexpected operation preparation"),
  startOperation: () => Effect.die("Unexpected operation start"),
  stopRun: () => Effect.die("Unexpected run stop"),
  ...overrides,
});

const makeLayer = (runtime: MigrationCliRuntimeShape) =>
  Layer.mergeAll(
    CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
    Layer.succeed(MigrationCliRuntime, runtime),
    nodeServicesLayer,
    Stdio.layerTest({}),
    TestConsole.layer
  );

const runCli = (
  args: readonly string[],
  connection: MigrationCliServerConnection
) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      Command.runWith(migrateCommand, { version: "0.0.0" })(args)
    );

    return {
      cause: isFailure(exit) ? prettyCause(exit.cause) : "",
      exitCode: isSuccess(exit) ? 0 : 1,
      stderr: (yield* TestConsole.errorLines).map(String).join("\n"),
      stdout: (yield* TestConsole.logLines).map(String).join("\n"),
    };
  }).pipe(
    Effect.provide(
      makeLayer({
        connectMigrateServer: () => Effect.succeed(connection),
        cwd: "/workspace",
      })
    )
  );

const withServer = (args: readonly string[]) => [
  ...args,
  "--server",
  "https://migrate.example/api/migrate",
];

describe("remote CLI inspection commands", () => {
  it.effect(
    "reads list and graph metadata without loading dashboard state",
    () =>
      Effect.gen(function* () {
        const connection = makeConnection({
          getDashboard: Effect.die("Dashboard must not be loaded"),
        });
        const list = yield* runCli(withServer(["list"]), connection);
        const graph = yield* runCli(
          withServer(["graph", "articles"]),
          connection
        );

        expect(list.exitCode).toBe(0);
        expect(list.stdout).toContain("Migration Definitions");
        expect(list.stdout).toContain("articles");
        expect(graph.exitCode).toBe(0);
        expect(graph.stdout).toContain("Migration Dependency Graph: articles");
        expect(graph.stdout).toContain("articles(required) --> authors");
      })
  );

  it.effect("sends the complete status request to the server", () =>
    Effect.gen(function* () {
      const request = yield* Ref.make<MigrateRegistryStatusRequest | undefined>(
        undefined
      );
      const connection = makeConnection({
        getRegistryStatus: (input) =>
          Ref.set(request, input).pipe(
            Effect.as({
              definitions: [articlesStatus],
              includedDefinitionIds: [authorsId, articlesId],
              notices: [],
              requestedDefinitionIds: [articlesId],
              scanSource: true,
              warnings: [],
            })
          ),
      });
      const result = yield* runCli(
        withServer([
          "status",
          "articles",
          "--with-dependencies",
          "--scan-source",
          "--concurrency",
          "2",
        ]),
        connection
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("source inventory");
      expect(yield* Ref.get(request)).toEqual({
        concurrency: 2,
        scanSource: true,
        selection: { definitionIds: [articlesId], kind: "definitions" },
        withDependencies: true,
      });
    })
  );

  it.effect("renders canonical server validation errors", () =>
    Effect.gen(function* () {
      const missingDependency = yield* runCli(
        withServer(["status", "articles"]),
        makeConnection({
          getRegistryStatus: () =>
            Effect.fail(
              new MigrationDefinitionRegistryMissingExplicitRequiredDependenciesError(
                {
                  definitionId: articlesId,
                  message:
                    "Migration Definition selection is missing required dependencies",
                  missingDependencyIds: [authorsId],
                }
              )
            ),
        })
      );
      const invalidConcurrency = yield* runCli(
        withServer(["status", "--all", "--concurrency", "2"]),
        makeConnection({
          getRegistryStatus: () =>
            Effect.fail(
              new MigrationStatusRequestError({
                message:
                  "Status concurrency is only valid when source scanning is enabled",
              })
            ),
        })
      );

      expect(missingDependency.exitCode).toBe(1);
      expect(missingDependency.stderr).toContain(
        "articles is missing required dependencies: authors"
      );
      expect(missingDependency.stderr).toContain(
        "migrate status --with-dependencies articles"
      );
      expect(invalidConcurrency.exitCode).toBe(1);
      expect(invalidConcurrency.stderr).toContain(
        "Status concurrency is only valid when source scanning is enabled"
      );
      expect(invalidConcurrency.stderr).not.toContain(
        "MigrationStatusRequestError"
      );
    })
  );

  it.effect("renders server messages and clears a remote lock", () =>
    Effect.gen(function* () {
      const connection = makeConnection({
        breakLock: () =>
          Effect.succeed({ definitionId: articlesId, kind: "cleared" }),
        getDashboard: Effect.succeed({
          dashboard: {
            activeRuns: [],
            groups: [],
            rows: [{ entry: articlesEntry, status: articlesStatus }],
            scannedSource: false,
          },
          resumeToken: MigrateDashboardResumeToken.make("dashboard-remote"),
        }),
        getRegistryMessages: () =>
          Effect.succeed({
            includedDefinitionIds: [articlesId],
            messages: [
              {
                definitionId: articlesId,
                kind: "skip-reason",
                message: "Already migrated remotely",
                runId,
                severity: "info",
                sourceIdentity: toEncodedSourceIdentity("article-1"),
                updatedAt: new Date("2026-08-29T11:30:00.000Z"),
              },
            ],
            notices: [],
            requestedDefinitionIds: [articlesId],
          }),
      });
      const messages = yield* runCli(
        withServer(["messages", "articles"]),
        connection
      );
      const unlock = yield* runCli(
        withServer(["unlock", "articles"]),
        connection
      );

      expect(messages.exitCode).toBe(0);
      expect(messages.stdout).toContain("Already migrated remotely");
      expect(unlock.exitCode).toBe(0);
      expect(unlock.stdout).toContain("Migration Definition lock cleared");
      expect(unlock.stdout).toContain("lock-remote");
    })
  );

  it.effect("accepts empty all-selection reports", () =>
    Effect.gen(function* () {
      const connection = makeConnection({
        getRegistry: Effect.succeed({ entries: [], groups: [] }),
        getRegistryMessages: () =>
          Effect.succeed({
            includedDefinitionIds: [],
            messages: [],
            notices: [],
            requestedDefinitionIds: "all" as const,
          }),
        getRegistryStatus: () =>
          Effect.succeed({
            definitions: [],
            includedDefinitionIds: [],
            notices: [],
            requestedDefinitionIds: "all" as const,
            scanSource: false,
            warnings: [],
          }),
      });
      const status = yield* runCli(withServer(["status", "--all"]), connection);
      const messages = yield* runCli(
        withServer(["messages", "--all"]),
        connection
      );

      expect(status.exitCode).toBe(0);
      expect(messages.exitCode).toBe(0);
    })
  );
});
