import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import {
  contractRecord,
  cursorRecord,
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

const initializeMysql = (
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

  return runStatements([
    sql`
      CREATE TABLE IF NOT EXISTS ${cursors} (
        definition_key CHAR(64) PRIMARY KEY,
        definition_id TEXT NOT NULL,
        cursor_value TEXT NOT NULL
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS ${contracts} (
        definition_key CHAR(64) PRIMARY KEY,
        definition_id TEXT NOT NULL,
        source_identity_contract_fingerprint TEXT NOT NULL,
        source_version_contract_fingerprint TEXT NOT NULL,
        tracking_record_contract_id TEXT NULL,
        tracking_record_contract_fingerprint TEXT NULL
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS ${itemStates} (
        definition_key CHAR(64) NOT NULL,
        definition_id TEXT NOT NULL,
        source_identity_key CHAR(64) NOT NULL,
        source_identity TEXT NOT NULL,
        status VARCHAR(32) NOT NULL,
        last_run_key CHAR(64) NOT NULL,
        last_run_id TEXT NOT NULL,
        updated_at VARCHAR(33) NOT NULL,
        source_version TEXT NULL,
        source_version_contract_fingerprint TEXT NULL,
        error_tag TEXT NULL,
        payload_json LONGTEXT NOT NULL,
        PRIMARY KEY (definition_key, source_identity_key),
        INDEX ${sql(`${prefix}_item_states_status_idx`)} (definition_key, status),
        INDEX ${sql(`${prefix}_item_states_run_idx`)} (last_run_key, definition_key)
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS ${runs} (
        run_key CHAR(64) PRIMARY KEY,
        run_id TEXT NOT NULL,
        status VARCHAR(32) NOT NULL,
        started_at VARCHAR(33) NOT NULL,
        finished_at VARCHAR(33) NULL,
        execution_adapter TEXT NULL,
        execution_id TEXT NULL,
        INDEX ${sql(`${prefix}_runs_started_idx`)} (started_at, run_key),
        INDEX ${sql(`${prefix}_runs_status_idx`)} (status, started_at)
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS ${runDefinitions} (
        run_key CHAR(64) NOT NULL,
        run_id TEXT NOT NULL,
        definition_key CHAR(64) NOT NULL,
        definition_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (run_key, definition_key),
        UNIQUE (run_key, position),
        INDEX ${sql(`${prefix}_run_definitions_definition_idx`)} (definition_key, run_key)
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS ${latestRuns} (
        definition_key CHAR(64) PRIMARY KEY,
        definition_id TEXT NOT NULL,
        run_key CHAR(64) NOT NULL
      )
    `,
    sql`
      CREATE TABLE IF NOT EXISTS ${locks} (
        definition_key CHAR(64) PRIMARY KEY,
        definition_id TEXT NOT NULL,
        owner_run_key CHAR(64) NOT NULL,
        owner_run_id TEXT NOT NULL,
        token TEXT NOT NULL,
        created_at VARCHAR(33) NOT NULL,
        INDEX ${sql(`${prefix}_locks_owner_idx`)} (owner_run_key, definition_key)
      )
    `,
  ]);
};

const makeMysqlUpsert =
  (sql: SqlClient.SqlClient): Upsert =>
  (table, row, keyColumns) =>
    sql`
      INSERT INTO ${sql(table)} ${sql.insert(row)}
      ON DUPLICATE KEY UPDATE ${sql.update(row, keyColumns)}
    `.pipe(Effect.asVoid);

export const makeMysqlDialect = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames,
  prefix: string
): SqlMigrationStoreDialect => {
  const locks = sql(names.locks);
  const upsert = makeMysqlUpsert(sql);

  return {
    initialize: initializeMysql(sql, names, prefix),
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
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO ${locks} (
              definition_key,
              definition_id,
              owner_run_key,
              owner_run_id,
              token,
              created_at
            ) VALUES (
              ${row.definitionKey},
              ${row.definitionId},
              ${row.ownerRunKey},
              ${row.ownerRunId},
              ${row.token},
              ${row.createdAt}
            )
            ON DUPLICATE KEY UPDATE definition_key = ${row.definitionKey}
          `;
          const rows = yield* sql<SqlTokenRow>`
            SELECT owner_run_id, token
            FROM ${locks}
            WHERE definition_key = ${row.definitionKey}
          `;

          return rows[0]?.token === row.token;
        })
      ),
    deleteOwnedLock: (row) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<SqlTokenRow>`
            SELECT owner_run_id, token
            FROM ${locks}
            WHERE definition_key = ${row.definitionKey}
            FOR UPDATE
          `;

          if (
            rows[0]?.owner_run_id !== row.ownerRunId ||
            rows[0]?.token !== row.token
          ) {
            return false;
          }

          yield* sql`
            DELETE FROM ${locks}
            WHERE definition_key = ${row.definitionKey}
              AND owner_run_id = ${row.ownerRunId}
              AND token = ${row.token}
          `;

          return true;
        })
      ),
    breakLock: (definitionKey) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`
            SELECT definition_id, owner_run_id, token, created_at
            FROM ${locks}
            WHERE definition_key = ${definitionKey}
            FOR UPDATE
          `;
          const row = rows[0];

          if (row === undefined) {
            return null;
          }

          yield* sql`
            DELETE FROM ${locks}
            WHERE definition_key = ${definitionKey}
          `;

          return row;
        })
      ),
  };
};
