import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { SqlMigrationStoreTableNames } from "../../sql-migration-store-dialect.ts";

export const addOperationHistoryAndCompletion = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.gen(function* () {
    const runs = sql(names.runs);

    yield* sql.onDialect({
      clickhouse: () =>
        Effect.die(
          "SQL Migration Store does not support the configured SQL dialect"
        ),
      mssql: () => sql`
      ALTER TABLE ${runs}
      ADD operation VARCHAR(32) NULL
    `,
      mysql: () => sql`
      ALTER TABLE ${runs}
      ADD COLUMN operation VARCHAR(32) NULL
    `,
      pg: () => sql`
      ALTER TABLE ${runs}
      ADD COLUMN operation VARCHAR(32) NULL
    `,
      sqlite: () => sql`
      ALTER TABLE ${runs}
      ADD COLUMN operation VARCHAR(32) NULL
    `,
    });

    const completions = sql(names.completions);
    const text = sql.onDialect({
      clickhouse: () => "TEXT",
      mssql: () => "NVARCHAR(MAX)",
      mysql: () => "LONGTEXT",
      pg: () => "TEXT",
      sqlite: () => "TEXT",
    });
    yield* sql`
    CREATE TABLE ${completions} (
      definition_key CHAR(64) PRIMARY KEY,
      definition_id ${sql.literal(text)} NOT NULL,
      run_id ${sql.literal(text)} NOT NULL,
      completed_at VARCHAR(33) NOT NULL,
      source_cursor ${sql.literal(text)} NULL
    )
  `;
  });
