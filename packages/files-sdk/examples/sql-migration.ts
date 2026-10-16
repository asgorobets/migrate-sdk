import type { Layer } from "effect";
import type { SqlClient } from "effect/sql";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";
import {
  makeObjectMigrationWithStore,
  type ObjectMigrationClients,
} from "./object-migration.ts";

/** Copy files with SQL-backed migration state. */
export function makeSqlBackedObjectMigration<E>(
  clients: Pick<ObjectMigrationClients, "source" | "destination">,
  sql: Layer.Layer<SqlClient.SqlClient, E>
) {
  return makeObjectMigrationWithStore(
    clients,
    SqlMigrationStore.layerFromClient(sql)
  );
}
