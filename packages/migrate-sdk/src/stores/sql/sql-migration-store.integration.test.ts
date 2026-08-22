import { MssqlClient } from "@effect/sql-mssql";
import { MysqlClient } from "@effect/sql-mysql2";
import { PgClient } from "@effect/sql-pg";
import { describe, expect, it } from "@effect/vitest";
import { Effect, type Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  MigrationStore,
  type MigrationStoreError,
  SourceIdentity,
  toEncodedSourceCursor,
  toMigrationDefinitionId,
  toMigrationRunId,
  toSourceVersion,
} from "migrate-sdk";
import {
  SqlMigrationStore,
  type SqlMigrationStoreOptions,
} from "migrate-sdk/stores/sql";

const password = Redacted.make("migrate_sdk");
const TestSourceIdentity = SourceIdentity.make({
  id: "sql-smoke@v1",
  schema: SourceIdentity.key("id", Schema.NonEmptyString),
});

type StoreLayer = Layer.Layer<MigrationStore, MigrationStoreError>;
type SqlProviderId = "mysql" | "postgres" | "sqlserver";

const makePostgresClient = () =>
  PgClient.layer({
    database: "migrate_sdk",
    host: "127.0.0.1",
    password,
    port: 55_432,
    username: "migrate_sdk",
  });

const makeMysqlClient = () =>
  MysqlClient.layer({
    database: "migrate_sdk",
    host: "127.0.0.1",
    password,
    port: 53_306,
    username: "migrate_sdk",
  });

const makeSqlServerClient = () =>
  MssqlClient.layer({
    database: "master",
    password: Redacted.make("MigrateSdk!2026"),
    port: 51_433,
    server: "127.0.0.1",
    username: "sa",
  });

function makePostgresStore(options?: SqlMigrationStoreOptions): StoreLayer {
  return SqlMigrationStore.layerFromClient(makePostgresClient(), options);
}

function makeMysqlStore(options?: SqlMigrationStoreOptions): StoreLayer {
  return SqlMigrationStore.layerFromClient(makeMysqlClient(), options);
}

function makeSqlServerStore(options?: SqlMigrationStoreOptions): StoreLayer {
  return SqlMigrationStore.layerFromClient(makeSqlServerClient(), options);
}

const removeObservationSchema = (
  provider: SqlProviderId,
  tablePrefix: string
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const itemStates = sql(`${tablePrefix}_item_states`);
    const orphanIndex = sql(`${tablePrefix}_item_states_orphan_idx`);

    switch (provider) {
      case "postgres":
        yield* sql`DROP INDEX IF EXISTS ${orphanIndex}`;
        yield* sql`
          ALTER TABLE ${itemStates}
          DROP COLUMN IF EXISTS last_source_inventory_run_id
        `;
        yield* sql`
          ALTER TABLE ${itemStates}
          DROP COLUMN IF EXISTS last_source_inventory_run_key
        `;
        break;
      case "mysql":
        yield* sql`ALTER TABLE ${itemStates} DROP INDEX ${orphanIndex}`;
        yield* sql`
          ALTER TABLE ${itemStates}
          DROP COLUMN last_source_inventory_run_id
        `;
        yield* sql`
          ALTER TABLE ${itemStates}
          DROP COLUMN last_source_inventory_run_key
        `;
        break;
      case "sqlserver":
        yield* sql`DROP INDEX ${orphanIndex} ON ${itemStates}`;
        yield* sql`
          ALTER TABLE ${itemStates}
          DROP COLUMN last_source_inventory_run_id
        `;
        yield* sql`
          ALTER TABLE ${itemStates}
          DROP COLUMN last_source_inventory_run_key
        `;
        break;
      default: {
        const unhandledProvider: never = provider;
        return unhandledProvider;
      }
    }
  });

function registerProviderSuite(
  providerId: SqlProviderId,
  provider: string,
  makeClientLayer: () => Layer.Layer<SqlClient.SqlClient, unknown>,
  makeStoreLayer: (options?: SqlMigrationStoreOptions) => StoreLayer
) {
  describe(provider, () => {
    it.effect("upgrades legacy observation storage without losing state", () =>
      Effect.gen(function* () {
        const tablePrefix = `legacy_smoke_${providerId}`;
        const definitionId = toMigrationDefinitionId("legacy-smoke-orphans");
        const sourceInventoryRunId = toMigrationRunId("legacy-smoke-inventory");
        const itemState = {
          definitionId,
          lastRunId: toMigrationRunId("legacy-smoke-migrate"),
          sourceIdentity: SourceIdentity.fromKey(
            TestSourceIdentity,
            "legacy-article"
          ),
          sourceVersion: toSourceVersion("version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-08-11T12:00:00.000Z"),
        };

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.upsertItemState(itemState);
        }).pipe(Effect.provide(makeStoreLayer({ tablePrefix })));

        yield* removeObservationSchema(providerId, tablePrefix).pipe(
          Effect.provide(makeClientLayer())
        );

        const observed = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.observeItemState(
            definitionId,
            itemState.sourceIdentity.encoded,
            sourceInventoryRunId
          );

          return yield* store.getItemState(
            definitionId,
            itemState.sourceIdentity.encoded
          );
        }).pipe(Effect.provide(makeStoreLayer({ tablePrefix })));

        expect(observed).toEqual({
          ...itemState,
          lastSourceInventoryRunId: sourceInventoryRunId,
        });
      })
    );

    it.effect("observes and pages orphaned item state", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("smoke-orphans");
        const sourceInventoryRunId = toMigrationRunId(
          "smoke-orphans-inventory"
        );
        const makeItemState = (identity: string) => ({
          definitionId,
          lastRunId: toMigrationRunId("smoke-orphans-migrate"),
          sourceIdentity: SourceIdentity.fromKey(TestSourceIdentity, identity),
          sourceVersion: toSourceVersion("version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-08-11T12:00:00.000Z"),
        });
        const articleUpperA = makeItemState("article-A");
        const articleLowerA = makeItemState("article-a");
        const articleB = makeItemState("article-b");
        const longIdentityPrefix = "long-identity".repeat(50);
        const longIdentityA = makeItemState(`${longIdentityPrefix}-1`);
        const longIdentityB = makeItemState(`${longIdentityPrefix}-2`);

        yield* store.upsertItemState(makeItemState("article-c"));
        yield* store.upsertItemState(articleUpperA);
        yield* store.upsertItemState(articleLowerA);
        yield* store.upsertItemState(articleB);
        yield* store.upsertItemState(longIdentityA);
        yield* store.upsertItemState(longIdentityB);
        yield* store.observeItemState(
          definitionId,
          articleB.sourceIdentity.encoded,
          sourceInventoryRunId
        );

        const orphanIdentities: string[] = [];
        let afterIdentity: typeof articleB.sourceIdentity.encoded | undefined;

        do {
          const page = yield* store.listOrphanItemStates(
            definitionId,
            sourceInventoryRunId,
            {
              limit: 1,
              ...(afterIdentity === undefined ? {} : { afterIdentity }),
            }
          );

          for (const item of page.items) {
            orphanIdentities.push(item.sourceIdentity.encoded);
            yield* store.deleteItemState(
              definitionId,
              item.sourceIdentity.encoded
            );
          }

          afterIdentity = page.nextAfterIdentity;
        } while (afterIdentity !== undefined);

        expect(orphanIdentities).toHaveLength(5);
        expect(new Set(orphanIdentities)).toEqual(
          new Set([
            "article-A",
            "article-a",
            "article-c",
            longIdentityA.sourceIdentity.encoded,
            longIdentityB.sourceIdentity.encoded,
          ])
        );
        expect(
          yield* store.getItemState(
            definitionId,
            articleB.sourceIdentity.encoded
          )
        ).toEqual({
          ...articleB,
          lastSourceInventoryRunId: sourceInventoryRunId,
        });
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("initializes and round-trips a source cursor", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("smoke-cursor");
        const cursor = toEncodedSourceCursor('{"offset":20}');

        yield* store.setSourceCursor(definitionId, cursor);
        expect(yield* store.getSourceCursor(definitionId)).toBe(cursor);

        yield* store.deleteSourceCursor(definitionId);
        expect(yield* store.getSourceCursor(definitionId)).toBeNull();
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("keeps the run lifecycle consistent across definitions", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionIds = [
          toMigrationDefinitionId("smoke-articles"),
          toMigrationDefinitionId("smoke-assets"),
        ];
        const runId = yield* store.createRunId;
        const execution = {
          adapter: "smoke-workflow",
          executionId: `execution-${runId}`,
        };

        const queued = yield* store.queueRun(runId, definitionIds);
        expect(queued).toEqual(
          expect.objectContaining({ runId, status: "queued" })
        );

        const attached = yield* store.attachRunExecution(
          runId,
          definitionIds,
          execution
        );
        expect(attached).toEqual(
          expect.objectContaining({ execution, runId, status: "queued" })
        );

        const running = yield* store.beginRun(runId, definitionIds);
        expect(running).toEqual(
          expect.objectContaining({ execution, runId, status: "running" })
        );

        const completed = yield* store.completeRun(runId, definitionIds);
        expect(completed).toEqual(
          expect.objectContaining({ execution, runId, status: "succeeded" })
        );
        expect(completed.finishedAt).toBeInstanceOf(Date);

        const latest = yield* Effect.forEach(definitionIds, (definitionId) =>
          store.getLatestRunState(definitionId)
        );
        expect(latest).toEqual([completed, completed]);
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("upserts item state and summarizes queryable statuses", () =>
      Effect.gen(function* () {
        const store = yield* MigrationStore;
        const definitionId = toMigrationDefinitionId("smoke-item-state");
        const runId = toMigrationRunId("smoke-item-state-run");
        const migrated = {
          definitionId,
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            TestSourceIdentity,
            "article-1"
          ),
          sourceVersion: toSourceVersion("version-1"),
          status: "migrated" as const,
          updatedAt: new Date("2026-08-11T12:00:00.000Z"),
        };
        const updated = {
          ...migrated,
          sourceVersion: toSourceVersion("version-2"),
          updatedAt: new Date("2026-08-11T12:00:01.000Z"),
        };
        const failed = {
          definitionId,
          error: {
            errorTag: "SqlSmokeError",
            kind: "process" as const,
            message: "Unable to migrate article",
          },
          lastRunId: runId,
          sourceIdentity: SourceIdentity.fromKey(
            TestSourceIdentity,
            "article-2"
          ),
          status: "failed" as const,
          updatedAt: new Date("2026-08-11T12:00:02.000Z"),
        };

        yield* store.upsertItemState(migrated);
        yield* store.upsertItemState(updated);
        yield* store.upsertItemState(failed);

        expect(
          yield* store.getItemState(
            definitionId,
            updated.sourceIdentity.encoded
          )
        ).toEqual(updated);
        expect(yield* store.getItemStateSummary(definitionId)).toEqual({
          failed: 1,
          migrated: 1,
          needsUpdate: 0,
          skipped: 0,
        });
      }).pipe(Effect.provide(makeStoreLayer()))
    );

    it.effect("enforces lock ownership across independent clients", () =>
      Effect.gen(function* () {
        const definitionId = toMigrationDefinitionId("smoke-lock");
        const ownerRunId = toMigrationRunId("smoke-lock-owner");
        const contenderRunId = toMigrationRunId("smoke-lock-contender");

        const lock = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          return yield* store.acquireDefinitionLock(definitionId, ownerRunId);
        }).pipe(Effect.provide(makeStoreLayer()));

        const duplicateError = yield* Effect.flip(
          Effect.gen(function* () {
            const store = yield* MigrationStore;
            return yield* store.acquireDefinitionLock(
              definitionId,
              contenderRunId
            );
          }).pipe(Effect.provide(makeStoreLayer()))
        );
        expect(duplicateError.message).toBe(
          "Migration definition is already locked"
        );

        const persisted = yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          return yield* store.getDefinitionLock(definitionId);
        }).pipe(Effect.provide(makeStoreLayer()));
        expect(persisted).toEqual(lock);

        yield* Effect.gen(function* () {
          const store = yield* MigrationStore;
          yield* store.releaseDefinitionLock(lock);
        }).pipe(Effect.provide(makeStoreLayer()));
      })
    );
  });
}

registerProviderSuite(
  "postgres",
  "PostgreSQL",
  makePostgresClient,
  makePostgresStore
);
registerProviderSuite("mysql", "MySQL", makeMysqlClient, makeMysqlStore);
registerProviderSuite(
  "sqlserver",
  "SQL Server",
  makeSqlServerClient,
  makeSqlServerStore
);
