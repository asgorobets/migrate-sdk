import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { createMssqlSchemaVersion1 } from "../../dialects/mssql.ts";
import { createMysqlSchemaVersion1 } from "../../dialects/mysql.ts";
import { createPostgresOrSqliteSchemaVersion1 } from "../../dialects/postgres-sqlite.ts";
import type { SqlMigrationStoreTableNames } from "../../sql-migration-store-dialect.ts";

export const makeInitialSqlMigrationStoreSchema = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames,
  prefix: string
): Effect.Effect<void, SqlError.SqlError> =>
  sql.onDialect({
    clickhouse: () =>
      Effect.die(
        "SQL Migration Store does not support the configured SQL dialect"
      ),
    mssql: () => createMssqlSchemaVersion1(sql, names, prefix),
    mysql: () => createMysqlSchemaVersion1(sql, names, prefix),
    pg: () => createPostgresOrSqliteSchemaVersion1(sql, names, prefix),
    sqlite: () => createPostgresOrSqliteSchemaVersion1(sql, names, prefix),
  });
