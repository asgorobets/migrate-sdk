import { PgClient } from "@effect/sql-pg";
import { Config } from "effect";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

export const migrationStoreTablePrefix = "migrate_workflow_sdk_example";

export const PostgresLive = PgClient.layerConfig({
  url: Config.redacted("DATABASE_URL"),
});

export const migrationStore = SqlMigrationStore.layerFromClient(PostgresLive, {
  tablePrefix: migrationStoreTablePrefix,
});
