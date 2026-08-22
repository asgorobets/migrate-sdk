import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import {
  contractRecord,
  cursorRecord,
  indexDefinitions,
  itemStateRecord,
  latestRunRecord,
  runRecord,
  runStatements,
  type SqlMigrationStoreDialect,
  type SqlMigrationStoreTableNames,
  type Upsert,
} from "./dialect.ts";

interface SqlTokenRow {
  readonly owner_run_id: string;
  readonly token: string;
}

const initializeMssql = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames,
  prefix: string
): Effect.Effect<void, SqlError.SqlError> => {
  const contracts = sql(names.contracts);
  const cursors = sql(names.cursors);
  const itemStates = sql(names.itemStates);
  const latestRuns = sql(names.latestRuns);
  const locks = sql(names.locks);
  const runDefinitions = sql(names.runDefinitions);
  const runs = sql(names.runs);
  const createTable = (
    name: string,
    statement: Effect.Effect<unknown, SqlError.SqlError>
  ) =>
    sql.onDialectOrElse({
      mssql: () => statement,
      orElse: () => Effect.die(`Expected SQL Server while creating ${name}`),
    });

  return runStatements([
    createTable(
      names.cursors,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.cursors)}', N'U') IS NULL
        CREATE TABLE ${cursors} (
          definition_key CHAR(64) PRIMARY KEY,
          definition_id NVARCHAR(MAX) NOT NULL,
          cursor_value NVARCHAR(MAX) NOT NULL
        )
      `
    ),
    createTable(
      names.contracts,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.contracts)}', N'U') IS NULL
        CREATE TABLE ${contracts} (
          definition_key CHAR(64) PRIMARY KEY,
          definition_id NVARCHAR(MAX) NOT NULL,
          source_identity_contract_fingerprint NVARCHAR(MAX) NOT NULL,
          source_version_contract_fingerprint NVARCHAR(MAX) NOT NULL,
          tracking_record_contract_id NVARCHAR(MAX) NULL,
          tracking_record_contract_fingerprint NVARCHAR(MAX) NULL
        )
      `
    ),
    createTable(
      names.itemStates,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.itemStates)}', N'U') IS NULL
        CREATE TABLE ${itemStates} (
          definition_key CHAR(64) NOT NULL,
          definition_id NVARCHAR(MAX) NOT NULL,
          source_identity_key CHAR(64) NOT NULL,
          source_identity NVARCHAR(MAX) NOT NULL,
          status VARCHAR(32) NOT NULL,
          last_run_key CHAR(64) NOT NULL,
          last_run_id NVARCHAR(MAX) NOT NULL,
          last_source_inventory_run_key CHAR(64) NULL,
          last_source_inventory_run_id NVARCHAR(MAX) NULL,
          updated_at VARCHAR(33) NOT NULL,
          source_version NVARCHAR(MAX) NULL,
          source_version_contract_fingerprint NVARCHAR(MAX) NULL,
          error_tag NVARCHAR(MAX) NULL,
          payload_json NVARCHAR(MAX) NOT NULL,
          PRIMARY KEY (definition_key, source_identity_key)
        )
      `
    ),
    createTable(
      names.runs,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.runs)}', N'U') IS NULL
        CREATE TABLE ${runs} (
          run_key CHAR(64) PRIMARY KEY,
          run_id NVARCHAR(MAX) NOT NULL,
          status VARCHAR(32) NOT NULL,
          started_at VARCHAR(33) NOT NULL,
          finished_at VARCHAR(33) NULL,
          execution_adapter NVARCHAR(MAX) NULL,
          execution_id NVARCHAR(MAX) NULL
        )
      `
    ),
    createTable(
      names.runDefinitions,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.runDefinitions)}', N'U') IS NULL
        CREATE TABLE ${runDefinitions} (
          run_key CHAR(64) NOT NULL,
          run_id NVARCHAR(MAX) NOT NULL,
          definition_key CHAR(64) NOT NULL,
          definition_id NVARCHAR(MAX) NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (run_key, definition_key),
          UNIQUE (run_key, position)
        )
      `
    ),
    createTable(
      names.latestRuns,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.latestRuns)}', N'U') IS NULL
        CREATE TABLE ${latestRuns} (
          definition_key CHAR(64) PRIMARY KEY,
          definition_id NVARCHAR(MAX) NOT NULL,
          run_key CHAR(64) NOT NULL
        )
      `
    ),
    createTable(
      names.locks,
      sql`
        IF OBJECT_ID(N'${sql.literal(names.locks)}', N'U') IS NULL
        CREATE TABLE ${locks} (
          definition_key CHAR(64) PRIMARY KEY,
          definition_id NVARCHAR(MAX) NOT NULL,
          owner_run_key CHAR(64) NOT NULL,
          owner_run_id NVARCHAR(MAX) NOT NULL,
          token NVARCHAR(MAX) NOT NULL,
          created_at VARCHAR(33) NOT NULL
        )
      `
    ),
    sql`
      IF COL_LENGTH(${names.itemStates}, 'last_source_inventory_run_key') IS NULL
      ALTER TABLE ${itemStates}
      ADD last_source_inventory_run_key CHAR(64) NULL
    `,
    sql`
      IF COL_LENGTH(${names.itemStates}, 'last_source_inventory_run_id') IS NULL
      ALTER TABLE ${itemStates}
      ADD last_source_inventory_run_id NVARCHAR(MAX) NULL
    `,
    ...[
      ...indexDefinitions(names, prefix),
      {
        columns:
          "definition_key, source_identity_key, last_source_inventory_run_key",
        name: `${prefix}_item_states_orphan_idx`,
        table: names.itemStates,
      },
    ].map(
      ({ columns, name, table }) =>
        sql`
        IF NOT EXISTS (
          SELECT 1
          FROM sys.indexes
          WHERE name = ${name}
            AND object_id = OBJECT_ID(${table})
        )
        CREATE INDEX ${sql(name)} ON ${sql(table)} (${sql.literal(columns)})
      `
    ),
  ]);
};

const makeMssqlUpsert =
  (sql: SqlClient.SqlClient): Upsert =>
  (table, row, keyColumns) => {
    const match = sql.and(
      keyColumns.map(
        (key) => sql`${sql.literal(`target.${key}`)} = ${row[key]}`
      )
    );

    return sql`
      MERGE ${sql(table)} WITH (HOLDLOCK) AS target
      USING (VALUES (1)) AS source (marker)
      ON ${match}
      WHEN MATCHED THEN UPDATE SET ${sql.update(row, keyColumns)}
      WHEN NOT MATCHED THEN INSERT ${sql.insert(row)};
    `.pipe(Effect.asVoid);
  };

export const makeMssqlDialect = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames,
  prefix: string
): SqlMigrationStoreDialect => {
  const locks = sql(names.locks);
  const itemStates = sql(names.itemStates);
  const upsert = makeMssqlUpsert(sql);

  return {
    initialize: initializeMssql(sql, names, prefix),
    listOrphanItemStateRows: (query) => {
      const whereAfterIdentity =
        query.afterIdentityKey === null
          ? sql``
          : sql`AND source_identity_key > ${query.afterIdentityKey}`;

      return sql`
        SELECT payload_json
        FROM ${itemStates}
        WHERE definition_key = ${query.definitionKey}
          AND definition_id = ${query.definitionId}
          AND (
            last_source_inventory_run_key IS NULL
            OR last_source_inventory_run_key <> ${query.sourceInventoryRunKey}
            OR last_source_inventory_run_id IS NULL
            OR last_source_inventory_run_id <> ${query.sourceInventoryRunId}
          )
          ${whereAfterIdentity}
        ORDER BY source_identity_key
        OFFSET 0 ROWS FETCH NEXT ${query.limit} ROWS ONLY
      `;
    },
    upsertCursor: (row) =>
      upsert(names.cursors, cursorRecord(row), ["definition_key"]),
    upsertContract: (row) =>
      upsert(names.contracts, contractRecord(row), ["definition_key"]),
    upsertItemState: (row) =>
      upsert(names.itemStates, itemStateRecord(row), [
        "definition_key",
        "source_identity_key",
      ]),
    upsertRun: (row) => upsert(names.runs, runRecord(row), ["run_key"]),
    upsertLatestRun: (row) =>
      upsert(names.latestRuns, latestRunRecord(row), ["definition_key"]),
    tryAcquireLock: (row) =>
      sql<SqlTokenRow>`
        INSERT INTO ${locks} (
          definition_key,
          definition_id,
          owner_run_key,
          owner_run_id,
          token,
          created_at
        )
        OUTPUT INSERTED.token
        SELECT
          ${row.definitionKey},
          ${row.definitionId},
          ${row.ownerRunKey},
          ${row.ownerRunId},
          ${row.token},
          ${row.createdAt}
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${locks} WITH (UPDLOCK, HOLDLOCK)
          WHERE definition_key = ${row.definitionKey}
        )
      `.pipe(Effect.map((rows) => rows.length > 0)),
    deleteOwnedLock: (row) =>
      sql`
        DELETE FROM ${locks}
        OUTPUT DELETED.definition_key
        WHERE definition_key = ${row.definitionKey}
          AND owner_run_id = ${row.ownerRunId}
          AND token = ${row.token}
      `.pipe(Effect.map((rows) => rows.length > 0)),
    breakLock: (definitionKey) =>
      sql`
        DELETE FROM ${locks}
        OUTPUT DELETED.definition_id, DELETED.owner_run_id, DELETED.token, DELETED.created_at
        WHERE definition_key = ${definitionKey}
      `.pipe(Effect.map((rows) => rows[0] ?? null)),
  };
};
