import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  MigrationDefinition,
  MigrationDefinitionRegistry,
  MigrationExecutable,
  SourceIdentity,
  toMigrationDefinitionId,
} from "../index.ts";
import { InMemorySource } from "../sources/in-memory/in-memory-source.ts";
import { SqlMigrationStore } from "../stores/sql/sql-migration-store.ts";
import { RegistryMigrateServer } from "./registry-server.ts";
import { MigrateServer } from "./service.ts";
import { makeStoreSchemaOperations } from "./store-schema.ts";

const sqliteLayer = SqliteClient.layer({
  filename: ":memory:",
  disableWAL: true,
});

describe("server store schema administration", () => {
  it.effect(
    "connects with v2, reviews and applies one upgrade, then loads the same server's dashboard",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* SqlMigrationStore.applySchemaPlan(
          yield* SqlMigrationStore.planSchema()
        );
        yield* sql`DROP TABLE migrate_sdk_completions`;
        yield* sql`ALTER TABLE migrate_sdk_runs DROP COLUMN operation`;
        yield* sql`DELETE FROM migrate_sdk_schema_migrations WHERE migration_id >= 3`;
        const clientLayer = Layer.succeed(SqlClient.SqlClient, sql);
        const definition = MigrationDefinition.make({
          id: toMigrationDefinitionId("authors"),
          process: () => undefined,
          source: InMemorySource.make({
            identity: SourceIdentity.make({
              id: "author@v1",
              schema: SourceIdentity.key("id", Schema.NonEmptyString),
            }),
            items: [],
            sourceSchema: Schema.Struct({ name: Schema.String }),
          }),
          store: SqlMigrationStore.layerFromClient(clientLayer, {
            initialize: false,
          }),
        });
        const context = yield* Layer.build(
          RegistryMigrateServer.layer({
            environment: { id: "test" },
            registry: MigrationDefinitionRegistry.make({
              definitions: [definition],
            }),
            sqlStore: { clientLayer },
          }).pipe(
            Layer.provide(
              Layer.succeed(
                MigrationExecutable,
                MigrationExecutable.inlineService
              )
            )
          )
        );
        const server = Context.get(context, MigrateServer);
        expect((yield* server.getServerInfo).environment.id).toBe("test");
        expect((yield* server.getRegistry).entries).toHaveLength(1);
        const plan = yield* server.getStoreSchema;
        expect(plan).toMatchObject({
          currentVersion: 2,
          targetVersion: 3,
          status: "upgrade-required",
          pending: [{ id: 3 }],
        });
        if (plan === null) {
          throw new Error("Expected a schema plan");
        }
        expect((yield* Effect.result(server.getDashboard))._tag).toBe(
          "Failure"
        );
        const stale = yield* Effect.result(
          server.upgradeStoreSchema({ acceptedPlanId: "stale" })
        );
        expect(stale._tag).toBe("Failure");
        expect((yield* server.getStoreSchema)?.currentVersion).toBe(2);
        const upgraded = yield* server.upgradeStoreSchema({
          acceptedPlanId: plan.planId,
        });
        expect(upgraded).toMatchObject({
          currentVersion: 3,
          status: "current",
          pending: [],
        });
        expect((yield* server.getDashboard).dashboard.rows[0]?.entry.id).toBe(
          "authors"
        );
        expect(
          yield* server.upgradeStoreSchema({ acceptedPlanId: plan.planId })
        ).toEqual(upgraded);
      }).pipe(Effect.scoped, Effect.provide(sqliteLayer))
  );

  it.effect("leaves non-SQL stores outside SQL schema administration", () =>
    Effect.gen(function* () {
      const operations = makeStoreSchemaOperations();
      expect(yield* operations.getSchema).toBeNull();
      expect(
        (yield* Effect.result(operations.upgradeSchema("unused")))._tag
      ).toBe("Failure");
    })
  );
});
