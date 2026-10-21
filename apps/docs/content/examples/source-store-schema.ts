import { Effect } from "effect";
import {
  SqlMigrationStore,
  type SqlMigrationStoreSchemaPlan,
} from "migrate-sdk/stores/sql";
import { migrationDatabase } from "./source-store-sql";

export const inspectSchema = SqlMigrationStore.planSchema({
  tablePrefix: "authors_migration",
}).pipe(Effect.provide(migrationDatabase));

// Call this with the exact plan you inspected and approved.
export const applySchema = (plan: SqlMigrationStoreSchemaPlan) =>
  SqlMigrationStore.applySchemaPlan(plan).pipe(
    Effect.provide(migrationDatabase)
  );
