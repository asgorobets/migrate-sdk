import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MigrationStore } from "migrate-sdk";
import { SqlMigrationStore } from "migrate-sdk/stores/sql";

interface SqliteNameRow {
  readonly name: string;
}

interface SqliteMigrationRow {
  readonly migration_id: number;
  readonly name: string;
}

const sha256Pattern = /^[a-f\d]{64}$/u;

const sqliteClientLayer = SqliteClient.layer({
  disableWAL: true,
  filename: ":memory:",
});

const withSqlite = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(sqliteClientLayer));

describe("SqlMigrationStore schema migrations", () => {
  it.effect("plans a fresh schema without changing the database", () =>
    withSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* SqlMigrationStore.planSchema();
        const tables = yield* sql<SqliteNameRow>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name LIKE 'migrate_sdk_%'
        `;

        expect(plan).toEqual(
          expect.objectContaining({
            applied: [],
            currentVersion: null,
            database: "sqlite",
            issues: [],
            pending: [
              {
                description: "Create the complete SQL Migration Store schema",
                id: 1,
                name: "initial_schema",
              },
            ],
            status: "not-installed",
            tablePrefix: "migrate_sdk",
            targetVersion: 1,
            warnings: [],
          })
        );
        expect(plan.planId).toMatch(sha256Pattern);
        expect(tables).toEqual([]);
      })
    )
  );

  it.effect("applies the inspected plan and records schema version 1", () =>
    withSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const initialPlan = yield* SqlMigrationStore.planSchema();
        const completedPlan =
          yield* SqlMigrationStore.applySchemaPlan(initialPlan);
        const migrations = yield* sql<SqliteMigrationRow>`
          SELECT migration_id, name
          FROM migrate_sdk_schema_migrations
          ORDER BY migration_id
        `;

        expect(completedPlan).toEqual(
          expect.objectContaining({
            applied: [{ id: 1, name: "initial_schema" }],
            currentVersion: 1,
            issues: [],
            pending: [],
            status: "current",
            targetVersion: 1,
          })
        );
        expect(migrations).toEqual([
          { migration_id: 1, name: "initial_schema" },
        ]);
        expect(yield* SqlMigrationStore.planSchema()).toEqual(completedPlan);
      })
    )
  );

  it.effect(
    "does not install a missing schema when initialization is disabled",
    () =>
      withSqlite(
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            Effect.service(MigrationStore).pipe(
              Effect.provide(SqlMigrationStore.layer({ initialize: false }))
            )
          );

          expect(error.message).toBe(
            "SQL migration store schema is not installed"
          );
          expect(yield* SqlMigrationStore.planSchema()).toEqual(
            expect.objectContaining({ status: "not-installed" })
          );
        })
      )
  );

  it.effect("refuses tables that have no SDK migration history", () =>
    withSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          CREATE TABLE migrate_sdk_cursors (
            definition_key TEXT PRIMARY KEY
          )
        `;

        const plan = yield* SqlMigrationStore.planSchema();
        const error = yield* Effect.flip(
          Effect.service(MigrationStore).pipe(
            Effect.provide(SqlMigrationStore.layer())
          )
        );

        expect(plan.status).toBe("untracked");
        expect(plan.issues).toEqual([
          expect.stringContaining("migrate_sdk_cursors"),
        ]);
        expect(error.message).toBe("SQL migration store schema is untracked");
      })
    )
  );

  it.effect("refuses a stale schema plan", () =>
    withSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const plan = yield* SqlMigrationStore.planSchema();

        yield* sql`
          CREATE TABLE migrate_sdk_cursors (
            definition_key TEXT PRIMARY KEY
          )
        `;

        const error = yield* Effect.flip(
          SqlMigrationStore.applySchemaPlan(plan)
        );

        expect(error.message).toBe(
          "SQL migration store schema changed after the plan was created"
        );
        expect(yield* SqlMigrationStore.planSchema()).toEqual(
          expect.objectContaining({ status: "untracked" })
        );
      })
    )
  );

  it.effect("detects partial, future, and divergent installed schemas", () =>
    withSqlite(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const initialPlan = yield* SqlMigrationStore.planSchema({
          tablePrefix: "partial_store",
        });

        yield* SqlMigrationStore.applySchemaPlan(initialPlan);
        yield* sql`DROP INDEX partial_store_item_states_orphan_idx`;

        const partialPlan = yield* SqlMigrationStore.planSchema({
          tablePrefix: "partial_store",
        });
        expect(partialPlan.status).toBe("partial");
        expect(partialPlan.issues).toContain(
          "Missing index partial_store_item_states_orphan_idx"
        );

        const futureInitialPlan = yield* SqlMigrationStore.planSchema({
          tablePrefix: "future_store",
        });
        yield* SqlMigrationStore.applySchemaPlan(futureInitialPlan);
        yield* sql`
          INSERT INTO future_store_schema_migrations (migration_id, name)
          VALUES (2, 'future_schema')
        `;
        expect(
          yield* SqlMigrationStore.planSchema({ tablePrefix: "future_store" })
        ).toEqual(expect.objectContaining({ status: "future" }));

        const divergentInitialPlan = yield* SqlMigrationStore.planSchema({
          tablePrefix: "divergent_store",
        });
        yield* SqlMigrationStore.applySchemaPlan(divergentInitialPlan);
        yield* sql`
          UPDATE divergent_store_schema_migrations
          SET name = 'changed_initial_schema'
          WHERE migration_id = 1
        `;
        expect(
          yield* SqlMigrationStore.planSchema({
            tablePrefix: "divergent_store",
          })
        ).toEqual(expect.objectContaining({ status: "divergent" }));
      })
    )
  );
});
