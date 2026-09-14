import { existsSync, writeFileSync } from "node:fs";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  SourceIdentity,
  toMigrationDefinitionId,
} from "migrate-sdk";
import { defineMigrationCliConfig } from "migrate-sdk/cli";
import { InMemorySource } from "migrate-sdk/sources/in-memory";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

const directory = process.env.MIGRATE_TUI_SCHEMA_FIXTURE_DIR;
if (directory === undefined) {
  throw new Error("MIGRATE_TUI_SCHEMA_FIXTURE_DIR is required");
}
const filename = `${directory}/state.sqlite`;
const seed = !existsSync(filename);
const clientLayer = SqliteClient.layer({ filename });
if (seed) {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* SqlMigrationStore.applySchemaPlan(
        yield* SqlMigrationStore.planSchema()
      );
      yield* sql`DROP TABLE migrate_sdk_completions`;
      yield* sql`ALTER TABLE migrate_sdk_runs DROP COLUMN operation`;
      yield* sql`DELETE FROM migrate_sdk_schema_migrations WHERE migration_id >= 3`;
    }).pipe(Effect.provide(clientLayer))
  );
}
writeFileSync(`${directory}/server.pid`, String(process.pid));

const authors = MigrationDefinition.make({
  id: toMigrationDefinitionId("authors"),
  process: () => undefined,
  source: InMemorySource.make({
    identity: SourceIdentity.make({
      id: "author@v1",
      schema: SourceIdentity.key("id", Schema.NonEmptyString),
    }),
    sourceSchema: Schema.Struct({ name: Schema.String }),
    items: [],
  }),
  store: SqlMigrationStore.layerFromClient(clientLayer, { initialize: false }),
});
export default defineMigrationCliConfig({
  registry: MigrationDefinitionRegistry.make({ definitions: [authors] }),
  sqlStore: { clientLayer },
});
