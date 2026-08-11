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
  names: SqlMigrationStoreTableNames,
  prefix: string
): SqlMigrationStoreDialect | null =>
  sql.onDialect({
    pg: () => makePostgresOrSqliteDialect(sql, names, prefix),
    sqlite: () => makePostgresOrSqliteDialect(sql, names, prefix),
    mysql: () => makeMysqlDialect(sql, names, prefix),
    mssql: () => makeMssqlDialect(sql, names, prefix),
    clickhouse: () => null,
  });
