import { Effect } from "effect";
import type { SqlError } from "effect/unstable/sql";

export interface SqlMigrationStoreTableNames {
  readonly contracts: string;
  readonly cursors: string;
  readonly itemStates: string;
  readonly latestRuns: string;
  readonly locks: string;
  readonly runDefinitions: string;
  readonly runs: string;
}

export interface SqlCursorWriteRow {
  readonly cursorValue: string;
  readonly definitionId: string;
  readonly definitionKey: string;
}

export interface SqlContractWriteRow {
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly sourceIdentityContractFingerprint: string;
  readonly sourceVersionContractFingerprint: string;
  readonly trackingRecordContractFingerprint: string | null;
  readonly trackingRecordContractId: string | null;
}

export interface SqlItemStateWriteRow {
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly errorTag: string | null;
  readonly lastRunId: string;
  readonly lastRunKey: string;
  readonly lastSourceInventoryRunId: string | null;
  readonly lastSourceInventoryRunKey: string | null;
  readonly payloadJson: string;
  readonly sourceIdentity: string;
  readonly sourceIdentityKey: string;
  readonly sourceVersion: string | null;
  readonly sourceVersionContractFingerprint: string | null;
  readonly status: string;
  readonly updatedAt: string;
}

export interface SqlOrphanItemStatePageQuery {
  readonly afterIdentityKey: string | null;
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly limit: number;
  readonly sourceInventoryRunId: string;
  readonly sourceInventoryRunKey: string;
}

export interface SqlRunWriteRow {
  readonly executionAdapter: string | null;
  readonly executionId: string | null;
  readonly finishedAt: string | null;
  readonly runId: string;
  readonly runKey: string;
  readonly startedAt: string;
  readonly status: string;
}

export interface SqlLatestRunWriteRow {
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly runKey: string;
}

export interface SqlLockWriteRow {
  readonly createdAt: string;
  readonly definitionId: string;
  readonly definitionKey: string;
  readonly ownerRunId: string;
  readonly ownerRunKey: string;
  readonly token: string;
}

export interface SqlOwnedLockRow {
  readonly definitionKey: string;
  readonly ownerRunId: string;
  readonly token: string;
}

export interface SqlMigrationStoreDialect {
  readonly breakLock: (
    definitionKey: string
  ) => Effect.Effect<unknown | null, SqlError.SqlError>;
  readonly deleteOwnedLock: (
    row: SqlOwnedLockRow
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly initialize: Effect.Effect<void, SqlError.SqlError>;
  readonly listOrphanItemStateRows: (
    query: SqlOrphanItemStatePageQuery
  ) => Effect.Effect<readonly unknown[], SqlError.SqlError>;
  readonly tryAcquireLock: (
    row: SqlLockWriteRow
  ) => Effect.Effect<boolean, SqlError.SqlError>;
  readonly upsertContract: (
    row: SqlContractWriteRow
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly upsertCursor: (
    row: SqlCursorWriteRow
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly upsertItemState: (
    row: SqlItemStateWriteRow
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly upsertLatestRun: (
    row: SqlLatestRunWriteRow
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly upsertRun: (
    row: SqlRunWriteRow
  ) => Effect.Effect<void, SqlError.SqlError>;
}

export interface SqlIndexDefinition {
  readonly columns: string;
  readonly name: string;
  readonly table: string;
}

export type SqlWriteRecord = Record<string, string | null>;

export type Upsert = (
  table: string,
  row: SqlWriteRecord,
  keyColumns: readonly string[]
) => Effect.Effect<void, SqlError.SqlError>;

export const runStatements = (
  statements: readonly Effect.Effect<unknown, SqlError.SqlError>[]
): Effect.Effect<void, SqlError.SqlError> =>
  Effect.forEach(statements, (statement) => statement, {
    concurrency: 1,
    discard: true,
  });

export const indexDefinitions = (
  names: SqlMigrationStoreTableNames,
  prefix: string
): readonly SqlIndexDefinition[] => [
  {
    columns: "definition_key, status",
    name: `${prefix}_item_states_status_idx`,
    table: names.itemStates,
  },
  {
    columns: "last_run_key, definition_key",
    name: `${prefix}_item_states_run_idx`,
    table: names.itemStates,
  },
  {
    columns: "started_at, run_key",
    name: `${prefix}_runs_started_idx`,
    table: names.runs,
  },
  {
    columns: "status, started_at",
    name: `${prefix}_runs_status_idx`,
    table: names.runs,
  },
  {
    columns: "definition_key, run_key",
    name: `${prefix}_run_definitions_definition_idx`,
    table: names.runDefinitions,
  },
  {
    columns: "owner_run_key, definition_key",
    name: `${prefix}_locks_owner_idx`,
    table: names.locks,
  },
];

export const cursorRecord = (row: SqlCursorWriteRow): SqlWriteRecord => ({
  cursor_value: row.cursorValue,
  definition_id: row.definitionId,
  definition_key: row.definitionKey,
});

export const contractRecord = (row: SqlContractWriteRow): SqlWriteRecord => ({
  definition_id: row.definitionId,
  definition_key: row.definitionKey,
  source_identity_contract_fingerprint: row.sourceIdentityContractFingerprint,
  source_version_contract_fingerprint: row.sourceVersionContractFingerprint,
  tracking_record_contract_fingerprint: row.trackingRecordContractFingerprint,
  tracking_record_contract_id: row.trackingRecordContractId,
});

export const itemStateRecord = (row: SqlItemStateWriteRow): SqlWriteRecord => ({
  definition_id: row.definitionId,
  definition_key: row.definitionKey,
  error_tag: row.errorTag,
  last_run_id: row.lastRunId,
  last_run_key: row.lastRunKey,
  last_source_inventory_run_id: row.lastSourceInventoryRunId,
  last_source_inventory_run_key: row.lastSourceInventoryRunKey,
  payload_json: row.payloadJson,
  source_identity: row.sourceIdentity,
  source_identity_key: row.sourceIdentityKey,
  source_version: row.sourceVersion,
  source_version_contract_fingerprint: row.sourceVersionContractFingerprint,
  status: row.status,
  updated_at: row.updatedAt,
});

export const runRecord = (row: SqlRunWriteRow): SqlWriteRecord => ({
  execution_adapter: row.executionAdapter,
  execution_id: row.executionId,
  finished_at: row.finishedAt,
  run_id: row.runId,
  run_key: row.runKey,
  started_at: row.startedAt,
  status: row.status,
});

export const latestRunRecord = (row: SqlLatestRunWriteRow): SqlWriteRecord => ({
  definition_id: row.definitionId,
  definition_key: row.definitionKey,
  run_key: row.runKey,
});
