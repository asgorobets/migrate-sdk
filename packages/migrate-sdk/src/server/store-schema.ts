import { Effect } from "effect";
import { MigrationStoreError } from "../domain/errors.ts";
import { SqlMigrationStore } from "../stores/sql/sql-migration-store.ts";
import type {
  SqlMigrationStoreSchemaConfig,
  SqlMigrationStoreSchemaPlan,
} from "../stores/sql/sql-migration-store-schema-plan.ts";

/** Uses the configured SQL client directly so an older store can be upgraded. */
export const makeStoreSchemaOperations = (
  target?: SqlMigrationStoreSchemaConfig
) => {
  const getSchema: Effect.Effect<SqlMigrationStoreSchemaPlan | null, unknown> =
    target === undefined
      ? Effect.succeed(null)
      : SqlMigrationStore.planSchema({
          ...(target.tablePrefix === undefined
            ? {}
            : { tablePrefix: target.tablePrefix }),
        }).pipe(Effect.provide(target.clientLayer));

  const upgradeSchema = (
    acceptedPlanId: string
  ): Effect.Effect<SqlMigrationStoreSchemaPlan, unknown> => {
    if (target === undefined) {
      return Effect.fail(
        new MigrationStoreError({
          message: "No SQL Migration Store is configured for schema upgrades",
        })
      );
    }
    return Effect.gen(function* () {
      const plan = yield* SqlMigrationStore.planSchema({
        ...(target.tablePrefix === undefined
          ? {}
          : { tablePrefix: target.tablePrefix }),
      });
      // Another client may have finished the same upgrade before this request arrived.
      if (plan.status === "current") {
        return plan;
      }
      if (plan.planId !== acceptedPlanId) {
        return yield* new MigrationStoreError({
          message:
            "The store schema plan changed. Review the updated plan before upgrading.",
        });
      }
      return yield* SqlMigrationStore.applySchemaPlan(plan);
    }).pipe(Effect.provide(target.clientLayer));
  };

  return { getSchema, upgradeSchema };
};
