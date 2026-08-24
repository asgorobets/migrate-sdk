import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { SqlMigrationStoreTableNames } from "../../sql-migration-store-dialect.ts";

export const addDefinitionRunStatus = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames
): Effect.Effect<unknown, SqlError.SqlError> => {
  const runDefinitions = sql(names.runDefinitions);

  return sql.onDialect({
    clickhouse: () =>
      Effect.die(
        "SQL Migration Store does not support the configured SQL dialect"
      ),
    mssql: () => sql`
      ALTER TABLE ${runDefinitions}
      ADD definition_status VARCHAR(32) NULL
    `,
    mysql: () => sql`
      ALTER TABLE ${runDefinitions}
      ADD COLUMN definition_status VARCHAR(32) NULL
    `,
    pg: () => sql`
      ALTER TABLE ${runDefinitions}
      ADD COLUMN definition_status VARCHAR(32) NULL
    `,
    sqlite: () => sql`
      ALTER TABLE ${runDefinitions}
      ADD COLUMN definition_status VARCHAR(32) NULL
    `,
  });
};
