import { layer as nodeFileSystemLayer } from "@effect/platform-node/NodeFileSystem";
import { MssqlClient } from "@effect/sql-mssql";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import { Effect, FileSystem, Redacted, Schedule, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  DestinationError,
  MigrationDefinition,
  MigrationDefinitionRegistry,
  type ProcessPipelineFor,
  type RollbackPipelineFor,
  Tracking,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import {
  SqlIdentity,
  SqlSource,
  type SqlSourceRead,
  type SqlSourceStatementCount,
} from "migrate-sdk/sources/sql";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const environment = process.env;
const provider = environment.MIGRATE_SQL_SMOKE_PROVIDER;
const processingMarkerPath =
  environment.MIGRATE_SQL_SMOKE_PROCESSING_MARKER_PATH;
const processingReleasePath =
  environment.MIGRATE_SQL_SMOKE_PROCESSING_RELEASE_PATH;
const tablePrefix = environment.MIGRATE_SQL_SMOKE_TABLE_PREFIX;
const slowArticleId = environment.MIGRATE_SQL_SMOKE_SLOW_ARTICLE_ID;

if (tablePrefix === undefined) {
  throw new Error("MIGRATE_SQL_SMOKE_TABLE_PREFIX must be set");
}

const sqlLayer = (() => {
  switch (provider) {
    case "postgres":
      return PgClient.layer({
        database: "migrate_sdk",
        host: "127.0.0.1",
        password: Redacted.make("migrate_sdk"),
        port: 55_432,
        username: "migrate_sdk",
      });
    case "mysql":
      return MysqlClient.layer({
        database: "migrate_sdk",
        host: "127.0.0.1",
        password: Redacted.make("migrate_sdk"),
        port: 53_306,
        username: "migrate_sdk",
      });
    case "sqlserver":
      return MssqlClient.layer({
        database: "master",
        password: Redacted.make("MigrateSdk!2026"),
        port: 51_433,
        server: "localhost",
        trustServer: true,
        username: "sa",
      });
    default:
      throw new Error(
        "MIGRATE_SQL_SMOKE_PROVIDER must be postgres, mysql, or sqlserver"
      );
  }
})();

const SqlArticleRow = Schema.Struct({
  id: Schema.NonEmptyString,
  source_version: Schema.Finite,
  title: Schema.String,
});
type SqlArticle = typeof SqlArticleRow.Type;
type EncodedSqlArticle = typeof SqlArticleRow.Encoded;

const SqlArticleCursor = Schema.Struct({
  id: Schema.NonEmptyString,
});
type SqlArticleCursor = typeof SqlArticleCursor.Type;

interface SqlArticleCountRow {
  readonly count: number | string;
}

const articleIdentity = SqlIdentity.columns({
  id: "sql-cli-article@v1",
  columns: [SqlIdentity.column("id", Schema.NonEmptyString)],
});

const readArticles: SqlSourceRead<EncodedSqlArticle, SqlArticleCursor> = (
  sql,
  cursor,
  limit
) => {
  if (provider === "sqlserver") {
    const limitFragment = sql.literal(String(limit));

    return cursor === null
      ? sql`
          SELECT id, title, source_version
          FROM sql_cli_source_articles
          ORDER BY id
          OFFSET 0 ROWS FETCH NEXT ${limitFragment} ROWS ONLY
        `
      : sql`
          SELECT id, title, source_version
          FROM sql_cli_source_articles
          WHERE id > ${cursor.id}
          ORDER BY id
          OFFSET 0 ROWS FETCH NEXT ${limitFragment} ROWS ONLY
        `;
  }

  if (provider === "mysql") {
    const limitFragment = sql.literal(String(limit));

    return cursor === null
      ? sql`
          SELECT id, title, source_version
          FROM sql_cli_source_articles
          ORDER BY id
          LIMIT ${limitFragment}
        `
      : sql`
          SELECT id, title, source_version
          FROM sql_cli_source_articles
          WHERE id > ${cursor.id}
          ORDER BY id
          LIMIT ${limitFragment}
        `;
  }

  return cursor === null
    ? sql`
        SELECT id, title, source_version
        FROM sql_cli_source_articles
        ORDER BY id
        LIMIT ${limit}
      `
    : sql`
        SELECT id, title, source_version
        FROM sql_cli_source_articles
        WHERE id > ${cursor.id}
        ORDER BY id
        LIMIT ${limit}
      `;
};

const countArticles: SqlSourceStatementCount<SqlArticleCountRow> = {
  getCount: (row) => Number(row.count),
  kind: "statement",
  statement: (sql) =>
    sql<SqlArticleCountRow>`
      SELECT COUNT(*) AS count
      FROM sql_cli_source_articles
    `,
};

const source = SqlSource.make({
  batchSize: 2,
  count: countArticles,
  cursorSchema: SqlArticleCursor,
  getSourceMetadata: (row) => ({
    cursor: { id: row.id },
    kind: "success",
    version: `version-${String(row.source_version)}`,
  }),
  identity: articleIdentity,
  lookup: (sql, identity) =>
    sql`
      SELECT id, title, source_version
      FROM sql_cli_source_articles
      WHERE id = ${identity.key}
    `,
  read: readArticles,
  sourceSchema: SqlArticleRow,
}).provide(sqlLayer);

const tracking = Tracking.record({
  id: "sql-cli-article-destination@v1",
  schema: Schema.Struct({ destinationId: Schema.NonEmptyString }),
});

const writeDestinationArticle = (article: SqlArticle) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM sql_cli_destination_articles
          WHERE id = ${article.id}
        `;
        yield* sql`
          INSERT INTO sql_cli_destination_articles (id, title, source_version)
          VALUES (${article.id}, ${article.title}, ${article.source_version})
        `;
        yield* sql`
          INSERT INTO sql_cli_destination_writes (article_id)
          VALUES (${article.id})
        `;
      })
    );
  }).pipe(
    Effect.provide(sqlLayer),
    Effect.mapError(
      (cause) =>
        new DestinationError({
          cause,
          message: `Unable to write SQL destination article ${article.id}`,
        })
    )
  );

const deleteDestinationArticle = (destinationId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM sql_cli_destination_articles
      WHERE id = ${destinationId}
    `;
  }).pipe(
    Effect.provide(sqlLayer),
    Effect.mapError(
      (cause) =>
        new DestinationError({
          cause,
          message: `Unable to delete SQL destination article ${destinationId}`,
        })
    )
  );

const store = SqlMigrationStore.layerFromClient(sqlLayer, {
  tablePrefix,
});

const processArticle: ProcessPipelineFor<
  typeof source,
  DestinationError,
  typeof tracking
> = Effect.fn("sqlCliArticles.process")(function* (sourceItem) {
  if (sourceItem.item.id === slowArticleId) {
    if (
      processingMarkerPath !== undefined &&
      processingReleasePath !== undefined
    ) {
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(processingMarkerPath, sourceItem.item.id);
        yield* fs.exists(processingReleasePath).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            while: (exists) => !exists,
          })
        );
      }).pipe(Effect.provide(nodeFileSystemLayer), Effect.orDie);
    } else {
      yield* Effect.sleep("2 seconds");
    }
  }

  yield* writeDestinationArticle(sourceItem.item);
  yield* Tracking.setRecord({
    destinationId: sourceItem.item.id,
  });
});

const rollbackArticle: RollbackPipelineFor<
  typeof tracking,
  DestinationError
> = (state) => {
  const trackingRecord = state.trackingRecord;

  return trackingRecord === undefined
    ? Effect.die("Expected SQL article tracking state")
    : deleteDestinationArticle(trackingRecord.destinationId);
};

const articles = MigrationDefinition.make({
  id: "articles",
  process: processArticle,
  rollback: rollbackArticle,
  source,
  store,
  tracking,
});

export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({
    definitions: [articles],
  }),
});
