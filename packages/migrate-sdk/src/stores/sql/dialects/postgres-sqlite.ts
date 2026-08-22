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

const initializePostgresOrSqlite = (
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
  const indexes = [
    ...indexDefinitions(names, prefix),
    {
      columns:
        "definition_key, source_identity_key, last_source_inventory_run_key",
      name: `${prefix}_item_states_orphan_idx`,
      table: names.itemStates,
    },
  ].map(
    ({ columns, name, table }) =>
      sql`CREATE INDEX IF NOT EXISTS ${sql(name)} ON ${sql(table)} (${sql.literal(columns)})`
  );

  const createTables = runStatements([
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
        last_source_inventory_run_key CHAR(64) NULL,
        last_source_inventory_run_id TEXT NULL,
        updated_at VARCHAR(33) NOT NULL,
        source_version TEXT NULL,
        source_version_contract_fingerprint TEXT NULL,
        error_tag TEXT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (definition_key, source_identity_key)
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
        execution_id TEXT NULL
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
        UNIQUE (run_key, position)
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
        created_at VARCHAR(33) NOT NULL
      )
    `,
  ]);

  const upgradeItemStates = sql.onDialectOrElse({
    pg: () =>
      runStatements([
        sql`
          ALTER TABLE ${itemStates}
          ADD COLUMN IF NOT EXISTS last_source_inventory_run_key CHAR(64) NULL
        `,
        sql`
          ALTER TABLE ${itemStates}
          ADD COLUMN IF NOT EXISTS last_source_inventory_run_id TEXT NULL
        `,
      ]),
    sqlite: () =>
      Effect.gen(function* () {
        interface SqliteTableInfoRow {
          readonly name: string;
        }

        const columns = yield* sql<SqliteTableInfoRow>`
          PRAGMA table_info(${sql.literal(names.itemStates)})
        `;
        const columnNames = new Set(columns.map((column) => column.name));

        if (!columnNames.has("last_source_inventory_run_key")) {
          yield* sql`
            ALTER TABLE ${itemStates}
            ADD COLUMN last_source_inventory_run_key CHAR(64) NULL
          `;
        }

        if (!columnNames.has("last_source_inventory_run_id")) {
          yield* sql`
            ALTER TABLE ${itemStates}
            ADD COLUMN last_source_inventory_run_id TEXT NULL
          `;
        }
      }),
    orElse: () =>
      Effect.die("Expected PostgreSQL or SQLite Migration Store dialect"),
  });

  return Effect.gen(function* () {
    yield* createTables;
    yield* upgradeItemStates;
    yield* runStatements(indexes);
  });
};

const makeOnConflictUpsert =
  (sql: SqlClient.SqlClient): Upsert =>
  (table, row, keyColumns) =>
    sql`
      INSERT INTO ${sql(table)} ${sql.insert(row)}
      ON CONFLICT (${sql.literal(keyColumns.join(", "))}) DO UPDATE SET
        ${sql.update(row, keyColumns)}
    `.pipe(Effect.asVoid);

export const makePostgresOrSqliteDialect = (
  sql: SqlClient.SqlClient,
  names: SqlMigrationStoreTableNames,
  prefix: string
): SqlMigrationStoreDialect => {
  const locks = sql(names.locks);
  const itemStates = sql(names.itemStates);
  const upsert = makeOnConflictUpsert(sql);

  return {
    initialize: initializePostgresOrSqlite(sql, names, prefix),
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
        LIMIT ${query.limit}
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
      sql`
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
        ON CONFLICT (definition_key) DO NOTHING
        RETURNING token
      `.pipe(Effect.map((rows) => rows.length > 0)),
    deleteOwnedLock: (row) =>
      sql`
        DELETE FROM ${locks}
        WHERE definition_key = ${row.definitionKey}
          AND owner_run_id = ${row.ownerRunId}
          AND token = ${row.token}
        RETURNING definition_key
      `.pipe(Effect.map((rows) => rows.length > 0)),
    breakLock: (definitionKey) =>
      sql`
        DELETE FROM ${locks}
        WHERE definition_key = ${definitionKey}
        RETURNING definition_id, owner_run_id, token, created_at
      `.pipe(Effect.map((rows) => rows[0] ?? null)),
  };
};
