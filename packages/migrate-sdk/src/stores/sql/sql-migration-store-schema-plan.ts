import type { Layer } from "effect";
import { Schema } from "effect";
import type { SqlClient } from "effect/unstable/sql";

export interface SqlMigrationStoreSchemaConfig {
  readonly clientLayer: Layer.Layer<SqlClient.SqlClient, unknown>;
  readonly tablePrefix?: string;
}

export const SqlMigrationStoreSchemaStatus = Schema.Literals([
  "not-installed",
  "current",
  "upgrade-required",
  "future",
  "divergent",
  "untracked",
  "partial",
]);
export type SqlMigrationStoreSchemaStatus =
  typeof SqlMigrationStoreSchemaStatus.Type;

export const SqlMigrationStoreSchemaDatabase = Schema.Literals([
  "microsoft-sql-server",
  "mysql",
  "postgresql",
  "sqlite",
]);
export type SqlMigrationStoreSchemaDatabase =
  typeof SqlMigrationStoreSchemaDatabase.Type;

const SchemaVersion = Schema.Finite.check(Schema.isInt()).check(
  Schema.isGreaterThan(0)
);
export const SqlMigrationStoreAppliedSchemaMigration = Schema.Struct({
  id: SchemaVersion,
  name: Schema.NonEmptyString,
});
export type SqlMigrationStoreAppliedSchemaMigration =
  typeof SqlMigrationStoreAppliedSchemaMigration.Type;

export const SqlMigrationStoreSchemaMigration = Schema.Struct({
  ...SqlMigrationStoreAppliedSchemaMigration.fields,
  description: Schema.String,
});
export type SqlMigrationStoreSchemaMigration =
  typeof SqlMigrationStoreSchemaMigration.Type;

/** A read-only comparison between the installed SQL schema and this SDK. */
export const SqlMigrationStoreSchemaPlan = Schema.Struct({
  applied: Schema.Array(SqlMigrationStoreAppliedSchemaMigration),
  currentVersion: Schema.NullOr(SchemaVersion),
  database: SqlMigrationStoreSchemaDatabase,
  issues: Schema.Array(Schema.String),
  pending: Schema.Array(SqlMigrationStoreSchemaMigration),
  planId: Schema.NonEmptyString,
  status: SqlMigrationStoreSchemaStatus,
  tablePrefix: Schema.NonEmptyString,
  targetVersion: SchemaVersion,
  warnings: Schema.Array(Schema.String),
});
export type SqlMigrationStoreSchemaPlan =
  typeof SqlMigrationStoreSchemaPlan.Type;
