import type { SqlMigrationStoreTableNames } from "./sql-migration-store-dialect.ts";

export const defaultSqlMigrationStoreTablePrefix = "migrate_sdk";

export const sqlMigrationStoreTablePrefixPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const makeSqlMigrationStoreTableNames = (
  prefix: string
): SqlMigrationStoreTableNames => ({
  contracts: `${prefix}_contracts`,
  cursors: `${prefix}_cursors`,
  itemStates: `${prefix}_item_states`,
  latestRuns: `${prefix}_latest_runs`,
  locks: `${prefix}_locks`,
  runDefinitions: `${prefix}_run_definitions`,
  runs: `${prefix}_runs`,
});

export const makeSqlMigrationStoreSchemaHistoryTableName = (
  prefix: string
): string => `${prefix}_schema_migrations`;
