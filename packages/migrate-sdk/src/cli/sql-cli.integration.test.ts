import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MssqlClient } from "@effect/sql-mssql";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, type Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  type MigrationItemStateSummary,
  type MigrationRunState,
  MigrationStore,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binPath = fileURLToPath(
  new URL("../../dist/cli/bin.js", import.meta.url)
);
const configPath = fileURLToPath(
  new URL("../../test-fixtures/sql-smoke/migrate.config.ts", import.meta.url)
);
const definitionId = toMigrationDefinitionId("articles");

interface DestinationArticleRow {
  readonly id: string;
  readonly source_version: number | string;
  readonly title: string;
}

interface DestinationWriteCountRow {
  readonly article_id: string;
  readonly write_count: number | string;
}

interface ExpectedDestinationArticleRow {
  readonly id: string;
  readonly sourceVersion: number;
  readonly title: string;
}

interface ObservedMigrationState {
  readonly lastRunStatus: MigrationRunState["status"] | undefined;
  readonly summary: MigrationItemStateSummary;
}

interface SqlCliProvider {
  readonly deleteThirdSourceArticle: Effect.Effect<void, unknown>;
  readonly failSecondSourceArticle: Effect.Effect<void, unknown>;
  readonly id: "mysql" | "postgres" | "sqlserver";
  readonly name: string;
  readonly readDestination: Effect.Effect<
    readonly ExpectedDestinationArticleRow[],
    unknown
  >;
  readonly readDestinationWriteCounts: Effect.Effect<
    Readonly<Record<string, number>>,
    unknown
  >;
  readonly readMigrationState: (
    tablePrefix: string
  ) => Effect.Effect<ObservedMigrationState, unknown>;
  readonly recoverSecondSourceArticle: Effect.Effect<void, unknown>;
  readonly reset: Effect.Effect<void, unknown>;
  readonly updateSecondSourceArticle: Effect.Effect<void, unknown>;
}

const resetScenario = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const table of [
    "sql_cli_destination_writes",
    "sql_cli_destination_articles",
    "sql_cli_source_articles",
  ]) {
    yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
  }

  yield* sql`
    CREATE TABLE sql_cli_source_articles (
      id VARCHAR(64) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      source_version INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE sql_cli_destination_articles (
      id VARCHAR(64) PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      source_version INTEGER NOT NULL,
      CONSTRAINT sql_cli_destination_title_check
        CHECK (title <> 'Rejected article')
    )
  `;
  yield* sql`
    CREATE TABLE sql_cli_destination_writes (
      article_id VARCHAR(64) NOT NULL
    )
  `;
  yield* sql`
    INSERT INTO sql_cli_source_articles (id, title, source_version)
    VALUES
      ('article-1', 'First article', 1),
      ('article-2', 'Second article', 1),
      ('article-3', 'Third article', 1)
  `;
});

const readDestination = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<DestinationArticleRow>`
    SELECT id, title, source_version
    FROM sql_cli_destination_articles
    ORDER BY id
  `;

  return rows.map((row) => ({
    id: row.id,
    sourceVersion: Number(row.source_version),
    title: row.title,
  }));
});

const readDestinationWriteCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<DestinationWriteCountRow>`
    SELECT article_id, COUNT(*) AS write_count
    FROM sql_cli_destination_writes
    GROUP BY article_id
    ORDER BY article_id
  `;

  return Object.fromEntries(
    rows.map((row) => [row.article_id, Number(row.write_count)])
  );
});

const updateSecondSourceArticle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE sql_cli_source_articles
    SET title = 'Second article updated', source_version = 2
    WHERE id = 'article-2'
  `;
});

const failSecondSourceArticle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE sql_cli_source_articles
    SET title = 'Rejected article'
    WHERE id = 'article-2'
  `;
});

const deleteThirdSourceArticle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM sql_cli_source_articles
    WHERE id = 'article-3'
  `;
});

const recoverSecondSourceArticle = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE sql_cli_source_articles
    SET title = 'Second article recovered', source_version = 2
    WHERE id = 'article-2'
  `;
});

const makeProvider = <ClientError>(
  id: SqlCliProvider["id"],
  name: string,
  layer: Layer.Layer<SqlClient.SqlClient, ClientError>
): SqlCliProvider => ({
  deleteThirdSourceArticle: deleteThirdSourceArticle.pipe(
    Effect.provide(layer)
  ),
  failSecondSourceArticle: failSecondSourceArticle.pipe(Effect.provide(layer)),
  id,
  name,
  readDestination: readDestination.pipe(Effect.provide(layer)),
  readDestinationWriteCounts: readDestinationWriteCounts.pipe(
    Effect.provide(layer)
  ),
  readMigrationState: (tablePrefix) =>
    Effect.gen(function* () {
      const store = yield* MigrationStore;
      const summary = yield* store.getItemStateSummary(definitionId);
      const latestRun = yield* store.getLatestRunState(definitionId);

      return { lastRunStatus: latestRun?.status, summary };
    }).pipe(
      Effect.provide(
        SqlMigrationStore.layerFromClient(layer, {
          initialize: false,
          tablePrefix,
        })
      )
    ),
  recoverSecondSourceArticle: recoverSecondSourceArticle.pipe(
    Effect.provide(layer)
  ),
  reset: resetScenario.pipe(Effect.provide(layer)),
  updateSecondSourceArticle: updateSecondSourceArticle.pipe(
    Effect.provide(layer)
  ),
});

const providers = [
  makeProvider(
    "postgres",
    "PostgreSQL",
    PgClient.layer({
      database: "migrate_sdk",
      host: "127.0.0.1",
      password: Redacted.make("migrate_sdk"),
      port: 55_432,
      username: "migrate_sdk",
    })
  ),
  makeProvider(
    "mysql",
    "MySQL",
    MysqlClient.layer({
      database: "migrate_sdk",
      host: "127.0.0.1",
      password: Redacted.make("migrate_sdk"),
      port: 53_306,
      username: "migrate_sdk",
    })
  ),
  makeProvider(
    "sqlserver",
    "SQL Server",
    MssqlClient.layer({
      database: "master",
      password: Redacted.make("MigrateSdk!2026"),
      port: 51_433,
      server: "127.0.0.1",
      username: "sa",
    })
  ),
] as const;

interface CliResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface CliRunOptions {
  readonly slowArticleId?: string;
  readonly tablePrefix: string;
}

class CliProcessError extends Data.TaggedError("CliProcessError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

const cliEnvironment = (
  provider: SqlCliProvider,
  options: CliRunOptions
): NodeJS.ProcessEnv => ({
  ...process.env,
  MIGRATE_SQL_SMOKE_PROVIDER: provider.id,
  MIGRATE_SQL_SMOKE_SLOW_ARTICLE_ID: options.slowArticleId,
  MIGRATE_SQL_SMOKE_TABLE_PREFIX: options.tablePrefix,
  NO_COLOR: "1",
});

const runCli = (
  provider: SqlCliProvider,
  options: CliRunOptions,
  args: readonly string[]
) =>
  Effect.sync(() => {
    const result = spawnSync(process.execPath, [binPath, ...args], {
      cwd: packageRoot,
      encoding: "utf8",
      env: cliEnvironment(provider, options),
    });

    if (result.error !== undefined) {
      throw result.error;
    }

    return {
      exitCode: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  });

const runCliAndInterrupt = (
  provider: SqlCliProvider,
  options: CliRunOptions,
  args: readonly string[],
  outputMarker: string
) =>
  Effect.callback<CliResult, CliProcessError>((resume) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: packageRoot,
      env: cliEnvironment(provider, options),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let interrupted = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!interrupted && stdout.includes(outputMarker)) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resume(
        Effect.fail(
          new CliProcessError({
            cause: error,
            message: "Unable to start the CLI cancellation test process",
          })
        )
      );
    });
    child.once("close", (exitCode) => {
      if (!interrupted) {
        const diagnostics = [stdout.trim(), stderr.trim()]
          .filter((output) => output.length > 0)
          .join("\n");
        resume(
          Effect.fail(
            new CliProcessError({
              message: `CLI exited before emitting ${outputMarker}${
                diagnostics === "" ? "" : `\n${diagnostics}`
              }`,
            })
          )
        );
        return;
      }
      resume(Effect.succeed({ exitCode, stderr, stdout }));
    });

    return Effect.sync(() => {
      child.kill("SIGKILL");
    });
  });

const expectSuccessfulCli = (result: {
  readonly exitCode: number | null;
  readonly stderr: string;
}) => {
  expect(result).toEqual(
    expect.objectContaining({
      exitCode: 0,
      stderr: "",
    })
  );
};

const emptySummary = {
  failed: 0,
  migrated: 0,
  needsUpdate: 0,
  skipped: 0,
} as const;

const makeTablePrefix = (
  provider: SqlCliProvider,
  scenario: "cancellation" | "failure" | "lifecycle"
): string => {
  const scenarioCode = {
    cancellation: "c",
    failure: "f",
    lifecycle: "l",
  }[scenario];

  return `sql_cli_${provider.id}_${scenarioCode}_${randomUUID().slice(0, 8)}`;
};

const initialDestinationRows = [
  { id: "article-1", sourceVersion: 1, title: "First article" },
  { id: "article-2", sourceVersion: 1, title: "Second article" },
  { id: "article-3", sourceVersion: 1, title: "Third article" },
] as const;

const updatedDestinationRows = [
  initialDestinationRows[0],
  { id: "article-2", sourceVersion: 2, title: "Second article updated" },
  initialDestinationRows[2],
] as const;

const recoveredDestinationRows = [
  initialDestinationRows[0],
  { id: "article-2", sourceVersion: 2, title: "Second article recovered" },
  initialDestinationRows[2],
] as const;

for (const provider of providers) {
  describe(`${provider.name} SQL CLI migration`, () => {
    it.effect(
      "runs, reports status, updates, rolls back, and reruns a target",
      () =>
        Effect.gen(function* () {
          const tablePrefix = makeTablePrefix(provider, "lifecycle");
          const options = { tablePrefix };
          yield* provider.reset;

          const firstRun = yield* runCli(provider, options, [
            "run",
            "--config",
            configPath,
            "--progress",
            "log",
            "articles",
          ]);
          expectSuccessfulCli(firstRun);
          expect(firstRun.stdout).toContain("Run Completed succeeded");
          expect(firstRun.stdout).toContain(
            "[progress] Source Cursor Window completed"
          );
          expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
            lastRunStatus: "succeeded",
            summary: { ...emptySummary, migrated: 3 },
          });
          expect(yield* provider.readDestination).toEqual(
            initialDestinationRows
          );

          const status = yield* runCli(provider, options, [
            "status",
            "--config",
            configPath,
            "articles",
          ]);

          expectSuccessfulCli(status);
          expect(status.stdout).toContain("Migration Status");
          expect(status.stdout).toContain("articles");

          yield* provider.updateSecondSourceArticle;
          const updateRun = yield* runCli(provider, options, [
            "run",
            "--config",
            configPath,
            "--update",
            "articles",
          ]);

          expectSuccessfulCli(updateRun);
          expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
            lastRunStatus: "succeeded",
            summary: { ...emptySummary, migrated: 3 },
          });
          expect(yield* provider.readDestination).toEqual(
            updatedDestinationRows
          );

          const rollback = yield* runCli(provider, options, [
            "rollback",
            "--config",
            configPath,
            "--id",
            "article-2",
            "articles",
          ]);

          expectSuccessfulCli(rollback);
          expect(rollback.stdout).toContain("Rollback Completed succeeded");
          expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
            lastRunStatus: "succeeded",
            summary: { ...emptySummary, migrated: 2 },
          });
          expect(yield* provider.readDestination).toEqual([
            updatedDestinationRows[0],
            updatedDestinationRows[2],
          ]);

          const targetedRun = yield* runCli(provider, options, [
            "run",
            "--config",
            configPath,
            "--id",
            "article-2",
            "articles",
          ]);

          expectSuccessfulCli(targetedRun);
          expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
            lastRunStatus: "succeeded",
            summary: { ...emptySummary, migrated: 3 },
          });
          expect(yield* provider.readDestination).toEqual(
            updatedDestinationRows
          );

          yield* provider.deleteThirdSourceArticle;
          const rollbackOrphans = yield* runCli(provider, options, [
            "run",
            "--config",
            configPath,
            "--rollback-orphans",
            "articles",
          ]);

          expectSuccessfulCli(rollbackOrphans);
          expect(rollbackOrphans.stdout).toContain("Orphaned");
          expect(rollbackOrphans.stdout).toContain("Rolled Back");
          expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
            lastRunStatus: "succeeded",
            summary: { ...emptySummary, migrated: 2 },
          });
          expect(yield* provider.readDestination).toEqual(
            updatedDestinationRows.slice(0, 2)
          );
        })
    );

    it.effect("recovers a persisted item failure with --failed", () =>
      Effect.gen(function* () {
        const tablePrefix = makeTablePrefix(provider, "failure");
        const options = { tablePrefix };
        yield* provider.reset;
        yield* provider.failSecondSourceArticle;

        const failedRun = yield* runCli(provider, options, [
          "run",
          "--config",
          configPath,
          "articles",
        ]);

        expectSuccessfulCli(failedRun);
        expect(failedRun.stdout).toContain("Run Completed failed");
        expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
          lastRunStatus: "failed",
          summary: { ...emptySummary, failed: 1, migrated: 2 },
        });
        expect(yield* provider.readDestination).toEqual([
          initialDestinationRows[0],
          initialDestinationRows[2],
        ]);

        const failedStatus = yield* runCli(provider, options, [
          "status",
          "--config",
          configPath,
          "articles",
        ]);

        expectSuccessfulCli(failedStatus);
        expect(failedStatus.stdout).toContain("Migration Status");
        expect(failedStatus.stdout).toContain("articles");

        yield* provider.recoverSecondSourceArticle;
        const recoveryRun = yield* runCli(provider, options, [
          "run",
          "--config",
          configPath,
          "--failed",
          "articles",
        ]);

        expectSuccessfulCli(recoveryRun);
        expect(recoveryRun.stdout).toContain("Run Completed succeeded");
        expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
          lastRunStatus: "succeeded",
          summary: { ...emptySummary, migrated: 3 },
        });
        expect(yield* provider.readDestination).toEqual(
          recoveredDestinationRows
        );
      })
    );

    it.effect("drains active work on SIGINT and resumes without replay", () =>
      Effect.gen(function* () {
        const tablePrefix = makeTablePrefix(provider, "cancellation");
        const options = { slowArticleId: "article-2", tablePrefix };
        yield* provider.reset;

        const cancelledRun = yield* runCliAndInterrupt(
          provider,
          options,
          ["run", "--config", configPath, "--concurrency", "1", "articles"],
          "[sql-smoke] processing article-2"
        );

        expect(cancelledRun.exitCode).toBe(130);
        expect(cancelledRun.stderr).toContain(
          "Cancellation requested; draining active migration work."
        );
        expect(cancelledRun.stdout).toContain("Run cancelled");
        expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
          lastRunStatus: "cancelled",
          summary: { ...emptySummary, migrated: 2 },
        });
        expect(yield* provider.readDestination).toEqual(
          initialDestinationRows.slice(0, 2)
        );
        expect(yield* provider.readDestinationWriteCounts).toEqual({
          "article-1": 1,
          "article-2": 1,
        });

        const resumedRun = yield* runCli(provider, { tablePrefix }, [
          "run",
          "--config",
          configPath,
          "articles",
        ]);

        expectSuccessfulCli(resumedRun);
        expect(resumedRun.stdout).toContain("Run Completed succeeded");
        expect(yield* provider.readMigrationState(tablePrefix)).toEqual({
          lastRunStatus: "succeeded",
          summary: { ...emptySummary, migrated: 3 },
        });
        expect(yield* provider.readDestination).toEqual(initialDestinationRows);
        expect(yield* provider.readDestinationWriteCounts).toEqual({
          "article-1": 1,
          "article-2": 1,
          "article-3": 1,
        });
      })
    );
  });
}
