import { PgClient } from "@effect/sql-pg";
import { Config } from "effect";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

export const migrationDatabase = PgClient.layerConfig({
  url: Config.Redacted("MIGRATION_DATABASE_URL"),
});

export const migrationStore = SqlMigrationStore.layerFromClient(
  migrationDatabase,
  { tablePrefix: "authors_migration" }
);
