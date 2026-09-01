import type { SqlClient } from "effect/unstable/sql";
import type {
  SqlMigrationStoreDialect,
  SqlMigrationStoreTableNames,
} from "./dialects/dialect.ts";
import { makeMssqlDialect } from "./dialects/mssql.ts";
import { makeMysqlDialect } from "./dialects/mysql.ts";
import { makePostgresOrSqliteDialect } from "./dialects/postgres-sqlite.ts";

export type {
  SqlContractWriteRow,
  SqlCursorWriteRow,
  SqlItemStateWriteRow,
  SqlLatestRunWriteRow,
  SqlLockWriteRow,
  SqlMigrationStoreDialect,
  SqlMigrationStoreTableNames,
  SqlOwnedLockRow,
  SqlRunWriteRow,
} from "./dialects/dialect.ts";

export const makeSqlMigrationStoreDialect = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames
): SqlMigrationStoreDialect | null =>
  sql.onDialect({
    pg: () => makePostgresOrSqliteDialect(sql, names),
    sqlite: () => makePostgresOrSqliteDialect(sql, names),
    mysql: () => makeMysqlDialect(sql, names),
    mssql: () => makeMssqlDialect(sql, names),
    clickhouse: () => null,
  });
